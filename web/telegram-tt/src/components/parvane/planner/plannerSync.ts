/* eslint-disable no-null/no-null -- контракт JSON движка (planner_json.rs): null = «не задано», отсутствие поля = «без изменений» */
import type {
  PlannerEvent, PlannerLearnedWord, PlannerList, PlannerOccurrence, PlannerQuickLine, PlannerRepeat, PlannerState,
  PlannerTask,
} from './plannerModel';

import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, normalizeLearned, normalizeQuickLines, PLANNER_REPEAT_KINDS,
  PLANNER_STATUSES,
} from './plannerModel';

// Parvane (spec 010): планировщик ↔ движок. Состояние для экранов (`PlannerState`)
// строится из JSON движка (только живые объекты, без меток); правки уходят
// движку списком изменений: присутствующее поле — правка регистра, `null` у
// числа — «не задано», `deleted: true` — надгробие. Метки ставит движок.
// Формат JSON — `backend/protocol/src/domain/planner_json.rs`.

// spec 011: правило повтора, состояние экземпляров, происхождение, задание-источник
type EngineRepeat = {
  kind: string; interval: number; weekdays: number[]; monthDay: number; startDay: string; endDay: string; count: number;
} | null;
type EngineOccurrence = { day: string; excluded: boolean; done: boolean; doneSteps: number[] };
type EngineOrigin = { seriesId: string; day: string } | null;
type EngineSource = { chat: string; opId: string } | null;
type EngineTask = {
  id: string;
  name: string;
  description: string;
  steps: { text: string; isDone: boolean }[];
  status: string;
  listId: string;
  rank: number;
  day: string;
  start: string;
  due: string;
  minutes: number | null;
  repeat?: EngineRepeat;
  occurrences?: EngineOccurrence[];
  origin?: EngineOrigin;
  source?: EngineSource;
  remind?: number | null;
};
type EngineEvent = {
  id: string; name: string; start: string; end: string; weekdays: number[] | null; day: string;
  repeat?: EngineRepeat; occurrences?: EngineOccurrence[]; origin?: EngineOrigin;
  allDay?: boolean; isHoliday?: boolean; color?: number; description?: string; remind?: number | null;
  listId?: string; steps?: { text: string; isDone: boolean }[]; source?: EngineSource;
};
type EngineList = { id: string; name: string; order: number; color?: number };
// Слово словаря правок ввода текстом: `kind` пуст и `minutes: null` — «не выучено»
type EngineLearned = {
  id: string; kind: string; kindCount: number; minutes: number | null; minutesCount: number; touched: number;
};
// Запись истории ввода текстом: строка либо забытый шаблон (`hidden`)
type EngineQuickLine = {
  id: string; text: string; count: number; touched: number; hidden: boolean;
};
type EngineSettings = {
  dayStart: number; dayEnd: number; lunchStart: number; lunchEnd: number; margin: number; budget: number;
  // Движок прежней сборки полей не отдаёт
  eventRemind?: number | null; remindDeadlines?: boolean; learnOff?: boolean;
} | null;
export type EngineState = {
  tasks: EngineTask[]; events: EngineEvent[]; lists: EngineList[]; settings: EngineSettings;
  // Движок прежней сборки словаря не отдаёт
  learned?: EngineLearned[];
  // История ввода текстом; движок прежней сборки её не знает — и не принимает правку `quickLine`
  quickLines?: EngineQuickLine[];
  // Отметки «напоминание отправлено»
  reminded?: string[];
  headSeq: number; sizeBytes: number;
};

export type PlannerChange = Record<string, unknown>;

// ── движок → состояние ───────────────────────────────────────────────────────

function repeatFrom(repeat: EngineRepeat | undefined, legacyWeekdays?: number[] | null): PlannerRepeat | undefined {
  if (repeat && PLANNER_REPEAT_KINDS.includes(repeat.kind as PlannerRepeat['kind'])) {
    return {
      kind: repeat.kind as PlannerRepeat['kind'],
      interval: repeat.interval || 1,
      weekdays: repeat.kind === 'weekly' ? repeat.weekdays : undefined,
      monthDay: repeat.kind === 'monthly' && repeat.monthDay ? repeat.monthDay : undefined,
      startDay: repeat.startDay || '',
      endDay: repeat.endDay || undefined,
      count: repeat.count || undefined,
    };
  }
  // События «по дням недели» этапов 1–2 — еженедельный ряд без нижней границы (R5)
  if (legacyWeekdays?.length) return { kind: 'weekly', interval: 1, weekdays: legacyWeekdays, startDay: '' };
  return undefined;
}

function occurrencesFrom(items: EngineOccurrence[] | undefined): PlannerOccurrence[] | undefined {
  if (!items?.length) return undefined;
  return items.map((o) => ({ day: o.day, excluded: o.excluded, done: o.done, doneSteps: o.doneSteps }));
}

// JSON записи считается один раз на объект: записи состояния не меняются на месте (правка идёт по глубокой
// копии), поэтому по нему и сравниваются версии одной записи — при разборе состояния движка и в `diffChanges`
const jsonByObject = new WeakMap<object, string>();

/** `JSON.stringify` объекта записи с кэшем по самому объекту. */
export function stableJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  let json = jsonByObject.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    jsonByObject.set(value, json);
  }
  return json;
}

// Записи с тем же id и тем же JSON берутся из прежнего состояния: строки и клетки, обёрнутые в `memo`, после эха
// движка не перерисовываются, а индексы по записям (`WeakMap`) продолжают действовать
function reuseById<T extends { id: string }>(next: T[], previous: T[] | undefined): T[] {
  if (!previous) return next;
  if (!next.length || !previous.length) return next.length === previous.length ? previous : next;
  const byId = new Map(previous.map((item) => [item.id, item]));
  let isSame = previous.length === next.length;
  const result = next.map((item, index) => {
    const before = byId.get(item.id);
    const kept = before && stableJson(before) === stableJson(item) ? before : item;
    if (kept !== previous[index]) isSame = false;
    return kept;
  });
  return isSame ? previous : result;
}

function reuseValue<T>(next: T, previous: T | undefined): T {
  return previous !== undefined && stableJson(previous) === stableJson(next) ? previous : next;
}

/**
 * JSON движка → состояние для экранов. `previous` — прежнее состояние экранов: записи, не изменившиеся по
 * JSON, берутся из него теми же объектами.
 */
export function fromEngineState(engine: EngineState, previous?: PlannerState): PlannerState {
  const empty = createEmptyPlannerState();
  const sorted = [...engine.lists].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
  // Задачи находят список по id, поэтому одноимённые списки (созданы на двух устройствах
  // без связи) показываются одним: в перечне остаётся первый
  const nameById = new Map(sorted.map((list) => [list.id, list.name]));
  const seenNames = new Set<string>();
  const lists: PlannerList[] = sorted.filter((list) => !seenNames.has(list.name) && seenNames.add(list.name))
    .map((list) => ({
      id: list.id, name: list.name, order: list.order, color: list.color || undefined,
    }));
  const tasks: PlannerTask[] = engine.tasks.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    steps: t.steps.map((s) => ({ text: s.text, isDone: s.isDone })),
    status: PLANNER_STATUSES.includes(t.status as PlannerTask['status']) ? t.status as PlannerTask['status'] : 'queue',
    project: nameById.get(t.listId) || '',
    rank: t.rank,
    day: t.day || undefined,
    start: t.start || undefined,
    due: t.due || undefined,
    minutes: t.minutes === null ? undefined : t.minutes,
    repeat: repeatFrom(t.repeat),
    occurrences: occurrencesFrom(t.occurrences),
    origin: t.origin ? { seriesId: t.origin.seriesId, day: t.origin.day } : undefined,
    remind: t.remind ?? undefined,
    source: t.source ? { chat: t.source.chat, opId: t.source.opId } : undefined,
  }));
  const s = engine.settings;
  const built: PlannerState = {
    ...empty,
    tasks,
    events: engine.events.map((e): PlannerEvent => {
      const repeat = repeatFrom(e.repeat, e.weekdays);
      return {
        id: e.id,
        name: e.name,
        // Движок прежней сборки поля не отдаёт
        description: e.description || undefined,
        start: e.start,
        end: e.end,
        day: !repeat && e.day ? e.day : undefined,
        repeat,
        occurrences: occurrencesFrom(e.occurrences),
        origin: e.origin ? { seriesId: e.origin.seriesId, day: e.origin.day } : undefined,
        isAllDay: e.allDay || undefined,
        isHoliday: e.isHoliday || undefined,
        color: e.color || undefined,
        remind: e.remind ?? undefined,
        // Группа — по id списка, как у задачи; движок прежней сборки поля не отдаёт
        project: (e.listId && nameById.get(e.listId)) || undefined,
        steps: e.steps?.length ? e.steps.map((step) => ({ text: step.text, isDone: step.isDone })) : undefined,
        source: e.source ? { chat: e.source.chat, opId: e.source.opId } : undefined,
      };
    }),
    projects: ['', ...lists.map((list) => list.name)],
    lists,
    budget: s?.budget ?? empty.budget,
    settings: s ? {
      dayStart: s.dayStart,
      dayEnd: s.dayEnd,
      lunchStart: s.lunchStart,
      lunchEnd: s.lunchEnd,
      margin: s.margin,
      eventRemind: s.eventRemind ?? undefined,
      shouldRemindDeadlines: s.remindDeadlines || undefined,
      isLearnOff: s.learnOff || undefined,
    } : { ...DEFAULT_PLANNER_SETTINGS },
    learned: normalizeLearned((engine.learned || []).map((word) => ({
      ...word, kind: word.kind as PlannerLearnedWord['kind'], minutes: word.minutes ?? undefined,
    }))),
    quickLines: normalizeQuickLines((engine.quickLines || []).map(({ hidden, ...line }) => ({
      ...line, isHidden: hidden,
    }))),
    reminded: [...(engine.reminded || [])].sort(),
  };
  if (!previous) return built;
  return {
    ...built,
    tasks: reuseById(built.tasks, previous.tasks),
    events: reuseById(built.events, previous.events),
    lists: reuseById(built.lists, previous.lists),
    projects: reuseValue(built.projects, previous.projects),
    settings: reuseValue(built.settings, previous.settings),
    learned: reuseById(built.learned, previous.learned),
    quickLines: reuseById(built.quickLines, previous.quickLines),
    reminded: reuseValue(built.reminded, previous.reminded),
  };
}

/**
 * Движок понимает историю ввода текстом (отдаёт `quickLines`). Движок прежней сборки отвергает операцию с
 * незнакомой правкой целиком — вместе с записью, добавленной той же правкой, — поэтому без этого признака
 * история в данные «Плана» не пишется и остаётся на устройстве.
 */
export function hasEngineQuickLines(engine: EngineState) {
  return Array.isArray(engine.quickLines);
}

// ── состояние → изменения ───────────────────────────────────────────────────

function listIdOf(state: PlannerState, name: string) {
  return name ? state.lists.find((list) => list.name === name)?.id || '' : '';
}

function repeatOf(repeat: PlannerRepeat | undefined) {
  if (!repeat) return null;
  return {
    kind: repeat.kind,
    interval: repeat.interval,
    weekdays: repeat.kind === 'weekly' ? repeat.weekdays || [] : [],
    monthDay: repeat.kind === 'monthly' ? repeat.monthDay || 0 : 0,
    startDay: repeat.startDay || '',
    endDay: repeat.endDay || '',
    count: repeat.count || 0,
  };
}

// Движок сливает экземпляры по дню — уходят только изменённые дни
function occurrencesOf(next: PlannerOccurrence[] | undefined, previous: PlannerOccurrence[] | undefined) {
  if (!next?.length) return [];
  const before = new Map((previous || []).map((o) => [o.day, o]));
  return next
    .filter((o) => stableJson(before.get(o.day)) !== stableJson(o))
    .map((o) => ({ day: o.day, excluded: Boolean(o.excluded), done: Boolean(o.done), doneSteps: o.doneSteps || [] }));
}

function seriesFields(item: PlannerTask | PlannerEvent, previous?: PlannerTask | PlannerEvent) {
  return {
    repeat: repeatOf(item.repeat),
    occurrences: occurrencesOf(item.occurrences, previous?.occurrences),
    origin: item.origin ? { seriesId: item.origin.seriesId, day: item.origin.day } : null,
  };
}

function taskChange(state: PlannerState, t: PlannerTask, previous?: PlannerTask): PlannerChange {
  return {
    task: {
      id: t.id,
      name: t.name,
      description: t.description,
      steps: t.steps.map((s) => ({ text: s.text, isDone: s.isDone })),
      status: t.status,
      listId: listIdOf(state, t.project),
      rank: t.rank,
      day: t.day || '',
      start: t.start || '',
      due: t.due || '',
      minutes: t.minutes === undefined ? null : t.minutes,
      ...seriesFields(t, previous),
      source: t.source ? { chat: t.source.chat, opId: t.source.opId } : null,
      remind: t.remind === undefined ? null : t.remind,
    },
  };
}

function eventChange(state: PlannerState, e: PlannerEvent, previous?: PlannerEvent): PlannerChange {
  const event: Record<string, unknown> = {
    id: e.id,
    name: e.name,
    start: e.start,
    end: e.end,
    weekdays: null,
    day: e.day || '',
    ...seriesFields(e, previous),
    allDay: Boolean(e.isAllDay),
    isHoliday: Boolean(e.isHoliday),
    color: e.color || 0,
    description: e.description || '',
    remind: e.remind === undefined ? null : e.remind,
    listId: listIdOf(state, e.project || ''),
  };
  // Шаги — только у события, у которого они есть или были: событие без шагов уходит без поля
  if (e.steps?.length || previous?.steps?.length) {
    event.steps = (e.steps || []).map((step) => ({ text: step.text, isDone: step.isDone }));
  }
  // Источник — тоже только у события из чата
  if (e.source || previous?.source) event.source = e.source ? { chat: e.source.chat, opId: e.source.opId } : null;
  return { event };
}

function listChange(l: PlannerList): PlannerChange {
  return {
    list: {
      id: l.id, name: l.name, order: l.order, color: l.color || 0,
    },
  };
}

// Слово словаря правок: значение и его счётчик уходят парой (движок сводит их отдельными регистрами,
// пара под одной меткой остаётся согласованной), и только изменившаяся пара — тип, исправленный на одном
// устройстве, не затирает длительность, исправленную на другом. Новое слово уходит целиком: оно могло
// быть удалено раньше, и прежние значения под надгробием не должны вернуться
function learnedChange(word: PlannerLearnedWord, before?: PlannerLearnedWord): PlannerChange {
  const change: Record<string, unknown> = { id: word.id };
  if (!before || before.kind !== word.kind || before.kindCount !== word.kindCount) {
    change.kind = word.kind || '';
    change.kindCount = word.kindCount;
  }
  if (!before || before.minutes !== word.minutes || before.minutesCount !== word.minutesCount) {
    change.minutes = word.minutes === undefined ? null : word.minutes;
    change.minutesCount = word.minutesCount;
  }
  if (!before || before.touched !== word.touched) change.touched = word.touched;
  return { learned: change };
}

function quickLineChange(line: PlannerQuickLine): PlannerChange {
  return {
    quickLine: {
      id: line.id, text: line.text, count: line.count, touched: line.touched, hidden: Boolean(line.isHidden),
    },
  };
}

// Настройки — регистр целиком: поле по умолчанию (нет напоминания, выключатели выключены) не уходит, движок
// читает его отсутствие тем же значением
function settingsChange(state: PlannerState): PlannerChange {
  const {
    dayStart, dayEnd, lunchStart, lunchEnd, margin, eventRemind, shouldRemindDeadlines, isLearnOff,
  } = state.settings;
  const settings: Record<string, unknown> = {
    dayStart, dayEnd, lunchStart, lunchEnd, margin, budget: state.budget,
  };
  if (eventRemind !== undefined) settings.eventRemind = eventRemind;
  if (shouldRemindDeadlines) settings.remindDeadlines = true;
  if (isLearnOff) settings.learnOff = true;
  return { settings };
}

/** Разница состояний → изменения для движка (объект целиком — LWW по полям у движка). */
// Правка существующего объекта несёт только изменившиеся поля: движок сводит объект по полям, и
// «попутная» запись неизменённых полей затирала бы правку тех же полей с другого устройства
// (правка времени на одном устройстве терялась, когда второе в это время отмечало выполнение)
function onlyChanged(kind: 'task' | 'event' | 'list', change: PlannerChange, before?: PlannerChange): PlannerChange {
  if (!before) return change;
  const next = change[kind] as Record<string, unknown>;
  const old = before[kind] as Record<string, unknown>;
  const fields = Object.entries(next).filter(([key, value]) => (
    // У события правило уходит всегда, парой: `weekdays: null` снимает правило прежнего формата
    // («по дням недели»), а `repeat` несёт то же правило в новом
    key === 'id' || (kind === 'event' && (key === 'weekdays' || key === 'repeat'))
    || (key === 'occurrences'
      ? (value as unknown[]).length > 0 : JSON.stringify(value) !== JSON.stringify(old[key]))
  ));
  return { [kind]: Object.fromEntries(fields) };
}

export function diffChanges(previous: PlannerState, next: PlannerState): PlannerChange[] {
  const changes: PlannerChange[] = [];
  // Тот же объект (запись переиспользована из прежнего состояния) — без сериализации
  const same = (a: unknown, b: unknown) => a === b || stableJson(a) === stableJson(b);
  // Коллекция по id: изменившиеся и новые — в порядке нового состояния, пропавшие — в порядке прежнего
  const diffById = <T extends { id: string }>(
    nextItems: T[], previousItems: T[],
    onChanged: (item: T, before?: T) => void, onDeleted: (item: T) => void,
  ) => {
    if (nextItems === previousItems) return;
    const before = new Map(previousItems.map((item) => [item.id, item]));
    const after = new Set<string>();
    nextItems.forEach((item) => {
      after.add(item.id);
      const old = before.get(item.id);
      if (!old || !same(old, item)) onChanged(item, old);
    });
    previousItems.forEach((item) => {
      if (!after.has(item.id)) onDeleted(item);
    });
  };

  diffById(next.lists, previous.lists, (list, before) => {
    changes.push(onlyChanged('list', listChange(list), before && listChange(before)));
  }, (list) => changes.push({ list: { id: list.id, deleted: true } }));

  diffById(next.tasks, previous.tasks, (task, before) => {
    changes.push(onlyChanged('task', taskChange(next, task, before), before && taskChange(previous, before)));
  }, (task) => changes.push({ task: { id: task.id, deleted: true } }));

  diffById(next.events, previous.events, (event, before) => {
    changes.push(onlyChanged('event', eventChange(next, event, before), before && eventChange(previous, before)));
  }, (event) => changes.push({ event: { id: event.id, deleted: true } }));

  if (!same(previous.settings, next.settings) || previous.budget !== next.budget) changes.push(settingsChange(next));

  diffById(next.learned, previous.learned, (word, before) => {
    changes.push(learnedChange(word, before));
  }, (word) => changes.push({ learned: { id: word.id, deleted: true } }));

  // История ввода текстом: запись уходит целиком (движок сводит её одним регистром), пропавшая — надгробием
  diffById(next.quickLines, previous.quickLines, (line) => {
    changes.push(quickLineChange(line));
  }, (line) => changes.push({ quickLine: { id: line.id, deleted: true } }));

  // Отметки «напомнено»: новая — регистр, снятая — надгробие
  if (next.reminded !== previous.reminded) {
    const before = new Set(previous.reminded);
    const after = new Set(next.reminded);
    next.reminded.forEach((id) => {
      if (!before.has(id)) changes.push({ reminded: { id } });
    });
    previous.reminded.forEach((id) => {
      if (!after.has(id)) changes.push({ reminded: { id, deleted: true } });
    });
  }
  return changes;
}

/** Данные этапа 1 (запись устройства) → изменения целиком; числовые id получают
 * префикс устройства, чтобы два устройства этапа 1 не дали коллизию (R7). */
export function legacyToChanges(legacy: PlannerState, devicePrefix: string): PlannerChange[] {
  const prefix = `legacy-${devicePrefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)}-`;
  const rename = (id: string) => (/^\d+$/.test(id) ? `${prefix}${id}` : id);
  const state: PlannerState = {
    ...legacy,
    tasks: legacy.tasks.map((t) => ({ ...t, id: rename(t.id) })),
    events: legacy.events.map((e) => ({ ...e, id: rename(e.id) })),
  };
  const changes = diffChanges(createEmptyPlannerState(), state);
  // Настройки по умолчанию diff не выдаёт — для переноса они не нужны
  changes.push({ migration: { sourceDevice: devicePrefix.slice(0, 64), count: changes.length } });
  return changes;
}

/** Запись устройства — ещё данные этапа 1 (не маркер переноса). */
export function isLegacyPlannerRecord(raw: unknown): raw is PlannerState {
  return Boolean(raw) && typeof raw === 'object' && (raw as { version?: unknown }).version === 1
    && Array.isArray((raw as { tasks?: unknown }).tasks);
}
