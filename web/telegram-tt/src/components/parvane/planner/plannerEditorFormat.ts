import type { LangFn } from '../../../util/localization';
import type { PlannerSeriesPromptMode } from './PlannerSeriesPrompt';

import { formatDate, formatDay, formatDuration } from './plannerFormat';
import { fromDayKey, toMinutes, toTime } from './plannerModel';

// Parvane (spec 041, доски `DkPlanMore`, `PhPlanMore`, `XpPlan`): значения карточки записи строкой

const MINUTES_IN_HOUR = 60;
const LAST_MINUTE = 1439;
const CLOCK_PATTERN = /^(\d{1,2}):([0-5]\d)$/;
const HOURS_PATTERN = /(\d+(?:[.,]\d+)?)\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours)(?![a-zа-я])/i;
const MINUTES_PATTERN = /(\d+)\s*(?:м|мин|минут|минута|минуты|m|min|mins|minute|minutes)(?![a-zа-я])/i;

/**
 * Длительность из поля: «90», «1:30», «1 ч 30 мин», «1,5 ч», «45 мин», «2h 15m». Пусто — `undefined`,
 * негодное — `NaN`.
 */
export function parseDuration(text: string): number | undefined {
  const value = text.trim().toLowerCase();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const clock = CLOCK_PATTERN.exec(value);
  if (clock) return Number(clock[1]) * MINUTES_IN_HOUR + Number(clock[2]);
  const hours = HOURS_PATTERN.exec(value);
  const minutes = MINUTES_PATTERN.exec(value);
  if (!hours && !minutes) return NaN;
  const rest = value.replace(HOURS_PATTERN, '').replace(MINUTES_PATTERN, '').trim();
  if (rest) return NaN;
  const total = (hours ? Number(hours[1].replace(',', '.')) * MINUTES_IN_HOUR : 0) + (minutes ? Number(minutes[1]) : 0);
  return Math.round(total);
}

/** День в строке карточки: «вс, 15 ноября». */
export function formatCardDay(lang: LangFn, day: string) {
  const weekday = formatDate(lang.code, fromDayKey(day), { weekday: 'short' }).replace(/\.$/, '');
  return `${weekday}, ${formatDay(lang, day)}`;
}

/** Длительность события по началу и концу; конец раньше начала — `undefined`. */
export function getSpanMinutes(start: string, end: string) {
  const span = toMinutes(end) - toMinutes(start);
  return span > 0 ? span : undefined;
}

/** Конец события по началу и длительности; за полночь — `undefined`. */
export function getEndByDuration(start: string, minutes: number) {
  const end = toMinutes(start) + minutes;
  return minutes > 0 && end <= LAST_MINUTE ? toTime(end) : undefined;
}

/** Значение поля «Длительность»: «1 ч 30 мин»; нет — пусто. */
export function formatDurationValue(lang: LangFn, minutes?: number) {
  return minutes ? formatDuration(lang, minutes) : '';
}

/** Значение «Напомнить» без повтора подписи: «В начале», «За 15 мин», «За 1 день». */
export function formatRemindShort(lang: LangFn, minutes: number) {
  if (!minutes) return lang('PlannerRemindShortStart');
  const day = 24 * MINUTES_IN_HOUR;
  const amount = minutes % day === 0
    ? lang('PlannerDaysValue', { days: minutes / day }, { pluralValue: minutes / day })
    : formatDuration(lang, minutes);
  return lang('PlannerRemindShortBefore', { amount });
}

/** «15 минут» полностью — запас в подсказке свободного времени (доска `ZpPlanX`). */
export function formatMinutesFull(lang: LangFn, minutes: number) {
  return lang('PlannerMinutesFull', { count: minutes }, { pluralValue: minutes });
}

/**
 * Пояснение выбора объёма правки ряда (доска `XpPlan`): «„Зал“ повторяется каждую неделю. К чему применить новое
 * время 19:00?» — время называется, когда правка меняет только его.
 */
export function formatSeriesAsk(
  lang: LangFn, mode: PlannerSeriesPromptMode, name: string, rule: string, newTime?: string,
) {
  if (mode === 'delete') return lang('PlannerSeriesAskDelete', { name, rule });
  if (mode === 'rule') return lang('PlannerSeriesAskRule', { name, rule });
  if (mode === 'stop') return lang('PlannerSeriesAskStop', { name, rule });
  if (mode === 'copy') return lang('PlannerSeriesAskCopy', { name });
  return newTime
    ? lang('PlannerSeriesAskTime', { name, rule, time: newTime })
    : lang('PlannerSeriesAskEdit', { name, rule });
}

/** Новое время правки, если меняется только время начала (и конец вместе с ним). */
export function getOnlyNewTime(
  changes: { start?: string; end?: string; [key: string]: unknown }, before: { start?: string; end?: string },
) {
  const keys = Object.keys(changes).filter((key) => changes[key] !== before[key as keyof typeof before]);
  if (!keys.length || keys.some((key) => key !== 'start' && key !== 'end')) return undefined;
  return changes.start && changes.start !== before.start ? changes.start : undefined;
}
