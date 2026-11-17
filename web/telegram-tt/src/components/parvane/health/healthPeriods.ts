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

const WEEK_DAYS = 7;

/** День `ГГГГ-ММ-ДД`, сдвинутый на `days` суток. */
export function shiftDay(day: string, days: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDayKey(date);
}

/** Значения показателя за период по порядку времени: дни без записей в ряд не входят. */
export function metricPoints(metric: Pick<HealthMetricView, 'series' | 'year'>, period: HealthPeriod, today: string) {
  if (period === 'year') {
    return metric.year.filter((item) => item.value !== undefined).map((item) => item.value!);
  }
  const from = period === 'week' ? shiftDay(today, 1 - WEEK_DAYS) : '';
  return metric.series.filter((point) => point.day >= from).map((point) => point.value);
}

/** Минуты сна по дням месяца либо по месяцам года; пропуск — `undefined`. Неделю показывает карточка сна. */
export function sleepPoints(sleep: Pick<HealthSleepView, 'month' | 'year'>, period: HealthPeriod) {
  if (period === 'year') return sleep.year.map((item) => item.minutes);
  return period === 'month' ? sleep.month.map((item) => item.minutes) : [];
}
