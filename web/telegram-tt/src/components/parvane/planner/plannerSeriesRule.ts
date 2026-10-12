import type {
  PlannerEvent, PlannerRepeat, PlannerSeriesItem, PlannerState, PlannerTask,
} from './plannerModel';
import type { PlannerSeriesKind } from './plannerSeriesEdit';

import {
  addDays, detachInstance, expandRepeat, hasInstanceOn, occursOn, splitSeries, truncateSeries, updateSeries,
} from './plannerModel';
import { findSeriesItem, FIRST_DAY_HORIZON } from './plannerSeriesEdit';

// Смена правила повтора из карточки экземпляра ряда. Одному дню своё правило не задать, поэтому объёмы —
// «с этого дня» и «весь ряд»; для «Не повторяется» — ряд кончается этим днём (день остаётся разовой записью)
// либо без повтора остаётся только этот день
export type PlannerRuleScope = 'following' | 'all' | 'stop' | 'one';

type SeriesPatch = Partial<PlannerTask & PlannerEvent>;

/** Одно и то же правило повтора (порядок дней недели не важен). */
export function sameRepeat(a: PlannerRepeat | undefined, b: PlannerRepeat | undefined) {
  if (!a || !b) return !a && !b;
  const weekdays = (repeat: PlannerRepeat) => (
    repeat.kind === 'weekly' ? [...(repeat.weekdays || [])].sort((x, y) => x - y).join(',') : ''
  );
  return a.kind === b.kind
    && a.interval === b.interval
    && weekdays(a) === weekdays(b)
    && (a.kind !== 'monthly' || (a.monthDay || 0) === (b.monthDay || 0))
    && a.startDay === b.startDay
    && (a.endDay || '') === (b.endDay || '')
    && (a.count || 0) === (b.count || 0);
}

/**
 * Смена правила повтора у экземпляра дня `day`; поля `patch` применяются в том же объёме (день из `patch`
 * берёт только разовая копия: дни ряда задаёт правило).
 * - `following`: прежний ряд кончается днём раньше, новый начинается с `day` по новому правилу; число повторов,
 *   которое пользователь не менял, уменьшается на уже прошедшие;
 * - `all`: правило меняется у всего ряда (дата начала — из правила), отметки дней, которых в ряду больше нет,
 *   отбрасываются;
 * - `stop` (правила нет): день остаётся разовой записью, ряд кончается днём раньше;
 * - `one` (правила нет): день остаётся разовой записью, ряд идёт дальше без него.
 * Возвращает запись, в которую попал день: ряд либо разовую копию.
 */
export function changeSeriesRule(
  state: PlannerState,
  kind: PlannerSeriesKind,
  id: string,
  day: string,
  repeat: PlannerRepeat | undefined,
  scope: PlannerRuleScope,
  patch: SeriesPatch = {},
): PlannerSeriesItem | undefined {
  const item = findSeriesItem(state, kind, id);
  if (!item?.repeat) return undefined;
  const fields = { ...patch };
  delete fields.day;
  delete fields.repeat;

  if (!repeat || scope === 'stop' || scope === 'one') {
    // Разовая копия может встать на другой день — тот, что выбран в карточке
    const detached = detachInstance(state, kind, id, day, patch.day ? { ...fields, day: patch.day } : fields);
    if (scope === 'stop') truncateSeries(state, kind, id, day);
    return detached;
  }

  const previous = item.repeat;
  if (scope === 'following' && previous.startDay && day > previous.startDay) {
    const next: Partial<PlannerRepeat> = { ...repeat, startDay: day };
    // Число повторов, оставшееся прежним, делится между рядами — как при любой правке «это и последующие»
    if ((repeat.count || 0) === (previous.count || 0)) delete next.count;
    // Конец прежнего ряда, оставшийся раньше нового начала, новому ряду не подходит
    if (next.endDay && next.endDay < day) next.endDay = undefined;
    return splitSeries(state, kind, id, day, { ...fields, repeat: next as PlannerRepeat });
  }

  // Весь ряд (и «с этого дня» у первого дня ряда — разделять нечего)
  updateSeries(state, kind, id, day, fields);
  const next: PlannerRepeat = { ...repeat };
  item.repeat = next;
  item.occurrences = item.occurrences?.filter((occurrence) => occursOn(next, occurrence.day));
  return item;
}

/** День, на котором карточку открыть после смены правила: тот же, если ряд его даёт, иначе ближайший следующий. */
export function nearestSeriesDay(item: PlannerSeriesItem, day: string) {
  if (!item.repeat) return undefined;
  if (hasInstanceOn(item, day)) return day;
  const from = item.repeat.startDay && item.repeat.startDay > day ? item.repeat.startDay : day;
  return expandRepeat(item.repeat, from, addDays(from, FIRST_DAY_HORIZON)).find((d) => hasInstanceOn(item, d));
}
