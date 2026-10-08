import type { LangFn } from '../../../util/localization';
import type { PlannerStatus } from './plannerModel';

import { fromDayKey } from './plannerModel';

// Parvane (spec 009): подписи планировщика — даты и длительности в языке интерфейса

const STATUS_KEYS = {
  queue: 'PlannerStatusQueue',
  active: 'PlannerStatusActive',
  later: 'PlannerStatusLater',
  waiting: 'PlannerStatusWaiting',
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
