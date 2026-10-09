import type { LangFn } from '../../../util/localization';
import type { PlannerRepeat, PlannerStatus } from './plannerModel';

import { fromDayKey, toTime } from './plannerModel';

// Parvane (spec 009): подписи планировщика — даты и длительности в языке интерфейса

const STATUS_KEYS = {
  queue: 'PlannerStatusQueue',
  active: 'PlannerStatusActive',
  done: 'PlannerStatusDone',
} as const satisfies Record<PlannerStatus, string>;

export function formatStatus(lang: LangFn, status: PlannerStatus) {
  return lang(STATUS_KEYS[status]);
}

export function formatProject(lang: LangFn, project: string) {
  return project || lang('PlannerNoList');
}

export function formatNumber(lang: LangFn, value: number, maximumFractionDigits = 1) {
  return value.toLocaleString(lang.code, { maximumFractionDigits });
}

export function formatHours(lang: LangFn, minutes: number) {
  return lang('PlannerHoursValue', { hours: formatNumber(lang, minutes / 60, 2) });
}

export function formatDuration(lang: LangFn, minutes: number) {
  if (minutes < 60) return lang('PlannerMinutesValue', { minutes });
  const hours = lang('PlannerHoursValue', { hours: Math.floor(minutes / 60) });
  return minutes % 60 ? `${hours} ${lang('PlannerMinutesValue', { minutes: minutes % 60 })}` : hours;
}

// Граница окна: ровный час — «09», иначе «08:30»
export function formatClock(minutes: number) {
  const clock = toTime(minutes);
  return minutes % 60 ? clock : clock.slice(0, 2);
}

export function formatDay(lang: LangFn, day: string) {
  return fromDayKey(day).toLocaleDateString(lang.code, { day: 'numeric', month: 'long' });
}

export function formatDayLong(lang: LangFn, day: string) {
  return capitalize(fromDayKey(day).toLocaleDateString(lang.code, { weekday: 'long', day: 'numeric', month: 'long' }));
}

export function formatMonth(lang: LangFn, month: Date) {
  return capitalize(month.toLocaleDateString(lang.code, { month: 'long', year: 'numeric' }).replace(/ г\.$/, ''));
}

// Понедельник — первым; `index` 0…6
export function formatWeekday(lang: LangFn, index: number, style: 'short' | 'long' = 'short') {
  // 5 января 2026 — понедельник
  return capitalize(new Date(2026, 0, 5 + index).toLocaleDateString(lang.code, { weekday: style }));
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Правило повтора одной строкой: «Каждые 2 нед.: Пн, Ср · до 31 дек. · 10 раз» (spec 011)
export function formatRepeat(lang: LangFn, repeat: PlannerRepeat) {
  const n = repeat.interval;
  let base: string;
  if (repeat.kind === 'daily') base = n === 1 ? lang('PlannerRepeatDaily') : lang('PlannerRepeatEveryDays', { n });
  else if (repeat.kind === 'weekly') {
    const days = [...(repeat.weekdays || [])]
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      .map((weekday) => formatWeekday(lang, (weekday + 6) % 7))
      .join(', ');
    base = n === 1 ? lang('PlannerRepeatWeekly', { days }) : lang('PlannerRepeatEveryWeeks', { n, days });
  } else if (repeat.kind === 'monthly') {
    const day = repeat.monthDay || (repeat.startDay ? fromDayKey(repeat.startDay).getDate() : 1);
    base = n === 1 ? lang('PlannerRepeatMonthly', { day }) : lang('PlannerRepeatEveryMonths', { n, day });
  } else {
    const date = repeat.startDay ? formatDay(lang, repeat.startDay) : '';
    base = n === 1 ? lang('PlannerRepeatYearly', { date }) : lang('PlannerRepeatEveryYears', { n, date });
  }
  const tail = [
    repeat.endDay ? lang('PlannerRepeatUntil', { date: formatDay(lang, repeat.endDay) }) : undefined,
    repeat.count ? lang('PlannerRepeatTimes', { count: repeat.count }) : undefined,
  ].filter(Boolean);
  return [base, ...tail].join(' · ');
}
