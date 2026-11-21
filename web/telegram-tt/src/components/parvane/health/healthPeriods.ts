import type { HealthMetricView, HealthSleepView } from './healthTypes';

import { localDayKey } from './healthFormat';

// Parvane (spec 041 B3): периоды подробного экрана — «Неделя / Месяц / Год». Ряды считает движок (`series` за
// 30 дней, `year` по месяцам); здесь — только выбор отрезка ряда для графика

export const PERIODS = ['week', 'month', 'year'] as const;
export type HealthPeriod = typeof PERIODS[number];

export const PERIOD_KEYS = {
  week: 'HealthPeriodWeek',
  month: 'HealthPeriodMonth',
  year: 'HealthPeriodYear',
} as const;

/** День `ГГГГ-ММ-ДД`, сдвинутый на `days` суток. */
export function shiftDay(day: string, days: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDayKey(date);
}

// Ячейка графика: день (`ГГГГ-ММ-ДД`) либо месяц (`ГГГГ-ММ`) с его значениями; пропуск — без значения
export type HealthChartSlot = { key: string; weekday: number; value?: number; value2?: number; goalMet?: boolean };

const PERIOD_DAYS = { week: 7, month: 30 } as const;

/** Ячейки графика за период: у недели и месяца — каждый день (пропуски пустые), у года — месяцы. */
export function chartSlots(
  { metric, sleep }: {
    metric?: Pick<HealthMetricView, 'series' | 'year'>;
    sleep?: Pick<HealthSleepView, 'month' | 'year'>;
  },
  period: HealthPeriod,
  today: string,
): HealthChartSlot[] {
  if (period === 'year') {
    const months = sleep ? sleep.year.map((item) => ({ key: item.month, value: item.minutes }))
      : metric!.year.map((item) => ({ key: item.month, value: item.value, value2: item.value2 }));
    return months.map((item) => ({ ...item, weekday: 0 }));
  }
  const days = PERIOD_DAYS[period];
  return Array.from({ length: days }, (_item, index) => {
    const day = shiftDay(today, index - days + 1);
    const weekday = (new Date(`${day}T12:00:00`).getDay() + 6) % 7;
    if (sleep) return { key: day, weekday, value: sleep.month.find((item) => item.day === day)?.minutes };
    const point = metric!.series.find((item) => item.day === day);
    return {
      key: day, weekday, value: point?.value, value2: point?.value2, goalMet: point?.goalMet,
    };
  });
}

/** Ряд сна за период для режима: неделя — дни недели сводки, месяц — 30 дней. */
export function sleepDays(sleep: Pick<HealthSleepView, 'week' | 'month'>, period: HealthPeriod) {
  return period === 'week' ? sleep.week : sleep.month;
}
