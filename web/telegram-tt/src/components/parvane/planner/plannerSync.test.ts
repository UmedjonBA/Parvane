/* eslint-disable no-null/no-null -- JSON движка: null = «не задано» */
import { describe, expect, it } from 'vitest';

import type { PlannerState } from './plannerModel';

import {
  createEmptyPlannerState, detachInstance, eventInstance, setEventStepDone,
} from './plannerModel';
import { addEntry, setDescription } from './plannerSeriesEdit';
import {
  diffChanges, type EngineState, fromEngineState, hasEngineQuickLines, isLegacyPlannerRecord, legacyToChanges,
} from './plannerSync';

const ENGINE: EngineState = {
  tasks: [{
    id: 't1',
    name: 'Задача',
    description: 'описание',
    steps: [{ text: 'шаг', isDone: true }],
    status: 'active',
    listId: 'l1',
    rank: 2,
    day: '2026-10-08',
    start: '10:00',
    due: '',
    minutes: 90,
  }, {
    id: 't2',
    name: 'Без оценки',
    description: '',
    steps: [],
    status: 'queue',
    listId: '',
    rank: 0,
    day: '',
    start: '',
    due: '',
    minutes: null,
  }],
  events: [{ id: 'e1', name: 'Стендап', start: '09:30', end: '09:45', weekdays: [1, 2], day: '' }, {
    id: 'e2',
    name: 'Бассейн',
    start: '19:00',
    end: '20:00',
    weekdays: null,
    day: '',
    repeat: {
      kind: 'weekly', interval: 1, weekdays: [1, 3], monthDay: 0, startDay: '2026-10-12', endDay: '', count: 0,
    },
    occurrences: [{ day: '2026-10-14', excluded: true, done: false, doneSteps: [] }],
    origin: null,
  }],
  lists: [{ id: 'l1', name: 'Работа', order: 0 }],
  settings: { dayStart: 480, dayEnd: 1200, lunchStart: 0, lunchEnd: 0, margin: 10, budget: 480 },
  headSeq: 7,
  sizeBytes: 1234,
};

describe('планировщик ↔ движок (spec 010)', () => {
  it('состояние движка превращается в состояние экранов: списки по имени, «не задано»', () => {
    const state = fromEngineState(ENGINE);
    expect(state.projects).toEqual(['', 'Работа']);
    expect(state.tasks[0]).toMatchObject({
      id: 't1', project: 'Работа', minutes: 90, day: '2026-10-08', due: undefined,
    });
    expect(state.tasks[1]).toMatchObject({ project: '', minutes: undefined, day: undefined });
    // События «по дням недели» этапов 1–2 читаются как еженедельный ряд без нижней границы (R5)
    expect(state.events[0])
      .toMatchObject({ repeat: { kind: 'weekly', interval: 1, weekdays: [1, 2], startDay: '' }, day: undefined });
    expect(state.events[1]).toMatchObject({
      repeat: { kind: 'weekly', weekdays: [1, 3], startDay: '2026-10-12', endDay: undefined, count: undefined },
      occurrences: [{ day: '2026-10-14', excluded: true, done: false, doneSteps: [] }],
      origin: undefined,
    });
    expect(state.budget).toBe(480);
    expect(state.settings.dayStart).toBe(480);
    // Здоровье, питание и цели «План» не хранит: в собственном состоянии они пусты
    expect(state).toMatchObject({
      nutrition: {}, goals: {}, goalPeriods: [], health: [], healthGoals: {},
    });
  });

  it('разница состояний — только изменённые объекты; удаление — надгробие; список создаётся', () => {
    const before = fromEngineState(ENGINE);
    const after: PlannerState = structuredClone(before);
    after.tasks[0].status = 'done';
    after.tasks = after.tasks.filter((t) => t.id !== 't2');
    after.lists.push({ id: 'l2', name: 'Дом', order: 1 });
    after.projects.push('Дом');
    after.tasks.push({
      id: 't3', name: 'Новая', description: '', steps: [], status: 'queue', project: 'Дом', rank: 1,
    });
    after.budget = 600;
    const changes = diffChanges(before, after);
    const kinds = changes.map((c) => Object.keys(c)[0]);
    expect(kinds.sort()).toEqual(['list', 'settings', 'task', 'task', 'task']);
    const taskChange = (id: string) => changes.find((c) => (c.task as { id?: string } | undefined)?.id === id);
    // Правка существующей задачи несёт только изменённое поле — остальные не переписываются
    expect(taskChange('t1')).toEqual({ task: { id: 't1', status: 'done' } });
    expect(taskChange('t2')).toEqual({ task: { id: 't2', deleted: true } });
    expect(taskChange('t3')).toMatchObject({ task: { listId: 'l2', minutes: null, day: '' } });
    expect(changes.find((c) => c.settings)).toEqual({ settings: { ...after.settings, budget: 600 } });
    // Ничего не менялось — изменений нет
    expect(diffChanges(after, structuredClone(after))).toEqual([]);
  });

  it('spec 011: правило повтора и только изменённые дни экземпляров', () => {
    const before = fromEngineState(ENGINE);
    const after: PlannerState = structuredClone(before);
    // Отметка ещё одного дня и правка правила ряда
    after.events[1].occurrences!.push({ day: '2026-10-21', excluded: true });
    after.events[1].repeat = { ...after.events[1].repeat!, endDay: '2026-12-31' };
    after.tasks[0].repeat = { kind: 'monthly', interval: 1, monthDay: 20, startDay: '2026-10-01' };
    after.tasks[0].occurrences = [{ day: '2026-10-20', done: true, doneSteps: [0] }];
    const changes = diffChanges(before, after);
    expect(changes.find((c) => (c.event as { id?: string } | undefined)?.id === 'e2')).toMatchObject({
      event: {
        repeat: {
          kind: 'weekly',
          interval: 1,
          weekdays: [1, 3],
          monthDay: 0,
          startDay: '2026-10-12',
          endDay: '2026-12-31',
          count: 0,
        },
        occurrences: [{ day: '2026-10-21', excluded: true, done: false, doneSteps: [] }],
        weekdays: null,
      },
    });
    expect(changes.find((c) => (c.task as { id?: string } | undefined)?.id === 't1')).toMatchObject({
      task: {
        repeat: {
          kind: 'monthly', interval: 1, weekdays: [], monthDay: 20, startDay: '2026-10-01', endDay: '', count: 0,
        },
        occurrences: [{ day: '2026-10-20', excluded: false, done: true, doneSteps: [0] }],
      },
    });
    // Унаследованное событие по дням недели при записи получает правило, а `weekdays` обнуляется
    const legacyEvent = structuredClone(before);
    legacyEvent.events[0].name = 'Стендап-2';
    expect(diffChanges(before, legacyEvent)[0]).toMatchObject({
      event: { id: 'e1', weekdays: null, repeat: { kind: 'weekly', weekdays: [1, 2], startDay: '' } },
    });
  });

  it('spec 013: цвет списка, «весь день», «праздник»; одноимённые списки — одним; прежние статусы', () => {
    const engine: EngineState = {
      ...ENGINE,
      tasks: [
        { ...ENGINE.tasks[0], status: 'later', listId: 'l2' },
        { ...ENGINE.tasks[1], status: 'waiting' },
      ],
      events: [{
        id: 'e3', name: 'Новый год', start: '00:00', end: '23:59', weekdays: null, day: '2027-01-01', allDay: true,
        isHoliday: true,
      }],
      lists: [{ id: 'l1', name: 'Работа', order: 0, color: 4 }, { id: 'l2', name: 'Работа', order: 1, color: 2 }],
    };
    const state = fromEngineState(engine);
    expect(state.lists).toEqual([{ id: 'l1', name: 'Работа', order: 0, color: 4 }]);
    expect(state.projects).toEqual(['', 'Работа']);
    // Задача второго одноимённого списка остаётся в «Работе»
    expect(state.tasks.map(({ status, project }) => [status, project])).toEqual([['queue', 'Работа'], ['queue', '']]);
    expect(state.events[0]).toMatchObject({ isAllDay: true, isHoliday: true });

    const next = structuredClone(state);
    next.lists[0].color = 7;
    next.events[0].isHoliday = false;
    const changes = diffChanges(state, next) as {
      list?: { color: number }; event?: Record<string, unknown>;
    }[];
    expect(changes.find((c) => c.list)!.list!.color).toBe(7);
    // Уходит только изменённое поле: неизменённое «весь день» не переписывается
    expect(changes.find((c) => c.event)!.event).toEqual({
      id: 'e3', weekdays: null, repeat: null, isHoliday: false,
    });
  });

  it('описание события: из движка в состояние и обратно отдельным полем', () => {
    const state = fromEngineState({
      ...ENGINE,
      events: [{
        id: 'e5',
        name: 'пара',
        start: '15:00',
        end: '16:45',
        weekdays: null,
        day: '2026-10-13',
        description: 'будет тест',
      }, {
        // Движок прежней сборки поля не отдаёт; пустая строка — описания нет
        id: 'e6', name: 'созвон', start: '10:00', end: '11:00', weekdays: null, day: '2026-10-13',
      }, {
        id: 'e7', name: 'обед', start: '13:00', end: '14:00', weekdays: null, day: '2026-10-13', description: '',
      }],
    });
    expect(state.events.map(({ description }) => description)).toEqual(['будет тест', undefined, undefined]);

    // Правка описания не переписывает время, правка времени — описание (сведение по полям между устройствами)
    const described = structuredClone(state);
    described.events[0].description = 'будет тест\nвзять тетрадь';
    described.events[1].description = 'обсудить бюджет';
    expect(diffChanges(state, described)).toEqual([
      { event: { id: 'e5', weekdays: null, repeat: null, description: 'будет тест\nвзять тетрадь' } },
      { event: { id: 'e6', weekdays: null, repeat: null, description: 'обсудить бюджет' } },
    ]);
    const moved = structuredClone(state);
    moved.events[0].start = '16:00';
    expect(diffChanges(state, moved)).toEqual([{ event: { id: 'e5', weekdays: null, repeat: null, start: '16:00' } }]);
    // Стёртое описание уходит пустой строкой
    const cleared = structuredClone(state);
    cleared.events[0].description = undefined;
    expect(diffChanges(state, cleared)).toEqual([
      { event: { id: 'e5', weekdays: null, repeat: null, description: '' } },
    ]);
    // Новое событие несёт описание вместе с остальными полями
    const created = structuredClone(state);
    created.events.push({
      id: 'e8', name: 'врач', start: '10:30', end: '11:30', day: '2026-10-09', description: 'взять полис',
    });
    expect((diffChanges(state, created)[0].event as { description: string }).description).toBe('взять полис');
  });

  it('шаги события: из движка и обратно отдельным полем; у дня ряда отметка — по дню', () => {
    const state = fromEngineState({
      ...ENGINE,
      events: [{
        id: 'e9',
        name: 'Зал',
        start: '18:00',
        end: '19:30',
        weekdays: null,
        day: '',
        repeat: {
          kind: 'weekly', interval: 1, weekdays: [0], monthDay: 0, startDay: '2026-11-15', endDay: '', count: 0,
        },
        steps: [{ text: 'Собрать сумку', isDone: false }, { text: 'Разминка', isDone: false }],
      }, {
        id: 'e10', name: 'созвон', start: '10:00', end: '11:00', weekdays: null, day: '2026-11-16', steps: [],
      }],
    });
    expect(state.events.map(({ steps }) => steps?.length)).toEqual([2, undefined]);
    // Отметка шага у дня ряда — отметка дня, шаги ряда не меняются
    const marked = structuredClone(state);
    expect(setEventStepDone(marked, eventInstance(marked.events[0], '2026-11-22'), 1, true)).toBe(true);
    expect(eventInstance(marked.events[0], '2026-11-22').steps!.map(({ isDone }) => isDone)).toEqual([false, true]);
    expect(eventInstance(marked.events[0], '2026-11-29').steps!.map(({ isDone }) => isDone)).toEqual([false, false]);
    const markChange = diffChanges(state, marked)[0].event as Record<string, unknown>;
    expect(Object.keys(markChange).sort()).toEqual(['id', 'occurrences', 'repeat', 'weekdays']);
    expect(markChange.occurrences).toEqual([{ day: '2026-11-22', excluded: false, done: false, doneSteps: [1] }]);
    // Отделённый день уносит отметки дня
    const detached = structuredClone(marked);
    const copy = detachInstance(detached, 'event', 'e9', '2026-11-22', { start: '19:00' })!;
    expect(copy.steps!.map(({ isDone }) => isDone)).toEqual([false, true]);
    // Новый шаг разового события — только поле шагов
    const added = structuredClone(state);
    added.events[1].steps = [{ text: 'Повестка', isDone: false }];
    expect(diffChanges(state, added)).toEqual([
      { event: { id: 'e10', weekdays: null, repeat: null, steps: [{ text: 'Повестка', isDone: false }] } },
    ]);
    expect(setEventStepDone(added, added.events[1], 0, true)).toBe(true);
    expect(added.events[1].steps[0].isDone).toBe(true);
  });

  it('правка одного поля не переписывает остальные (сведение по полям между устройствами)', () => {
    const before = fromEngineState(ENGINE);
    const after: PlannerState = structuredClone(before);
    after.tasks[0].start = '17:00';
    after.events[1].name = 'Бассейн 50 м';
    const changes = diffChanges(before, after);
    expect(changes[0]).toEqual({ task: { id: 't1', start: '17:00' } });
    // У события правило повтора уходит всегда (вместе со сбросом правила прежнего формата)
    expect(Object.keys(changes[1].event as object).sort()).toEqual(['id', 'name', 'repeat', 'weekdays']);
    // Отметка экземпляра ряда — только день экземпляра, без времени и названия задачи
    const marked: PlannerState = structuredClone(before);
    marked.events[1].occurrences!.push({ day: '2026-10-19', excluded: true });
    const markChange = diffChanges(before, marked)[0].event as Record<string, unknown>;
    expect(Object.keys(markChange).sort()).toEqual(['id', 'occurrences', 'repeat', 'weekdays']);
    expect(markChange.occurrences).toEqual([{ day: '2026-10-19', excluded: true, done: false, doneSteps: [] }]);
  });

  it('перенос этапа 1: числовые id получают префикс устройства, последним — отметка переноса', () => {
    const legacy = createEmptyPlannerState();
    legacy.tasks.push({
      id: '7', name: 'Старая', description: '', steps: [], status: 'queue', project: 'Дом', rank: 0,
    });
    legacy.lists.push({ id: 'list-x', name: 'Дом', order: 0 });
    legacy.projects.push('Дом');
    legacy.events.push({ id: '9', name: 'Событие', start: '10:00', end: '11:00', day: '2026-10-09' });
    const changes = legacyToChanges(legacy, 'web-1');
    expect(changes.map((c) => Object.keys(c)[0])).toEqual(['list', 'task', 'event', 'migration']);
    expect((changes[1].task as { id: string }).id).toBe('legacy-web-1-7');
    expect((changes[2].event as { id: string }).id).toBe('legacy-web-1-9');
    expect(changes[3]).toEqual({ migration: { sourceDevice: 'web-1', count: 3 } });
    expect(isLegacyPlannerRecord(legacy)).toBe(true);
    expect(isLegacyPlannerRecord({ migrated: true, at: 1 })).toBe(false);
  });
});

describe('планировщик ↔ движок: повторный разбор переиспользует объекты (C1)', () => {
  it('записи с тем же JSON — те же объекты, изменённые — новые; нетронутые коллекции — те же массивы', () => {
    const previous = fromEngineState(ENGINE);
    const same = fromEngineState(structuredClone(ENGINE), previous);
    expect(same).not.toBe(previous);
    expect(same.tasks).toBe(previous.tasks);
    expect(same.events).toBe(previous.events);
    expect(same.lists).toBe(previous.lists);
    expect(same.settings).toBe(previous.settings);
    expect(same.projects).toBe(previous.projects);

    const engine = structuredClone(ENGINE);
    engine.tasks[0].status = 'done';
    engine.tasks.push({ ...engine.tasks[1], id: 't9', name: 'Новая' });
    const next = fromEngineState(engine, previous);
    expect(next.tasks).not.toBe(previous.tasks);
    expect(next.tasks[0]).not.toBe(previous.tasks[0]);
    expect(next.tasks[0].status).toBe('done');
    expect(next.tasks[1]).toBe(previous.tasks[1]);
    expect(next.tasks[2].id).toBe('t9');
    expect(next.events).toBe(previous.events);
    // Разбор с прежним состоянием даёт то же, что разбор без него
    expect(next).toEqual(fromEngineState(engine));
    // Пропавшая запись — массив новый, оставшиеся объекты прежние
    const shorter = structuredClone(ENGINE);
    shorter.tasks.pop();
    const dropped = fromEngineState(shorter, previous);
    expect(dropped.tasks).toHaveLength(previous.tasks.length - 1);
    expect(dropped.tasks[0]).toBe(previous.tasks[0]);
  });
});

describe('планировщик ↔ движок: словарь правок ввода текстом', () => {
  const ENGINE_EMPTY: EngineState = {
    tasks: [], events: [], lists: [], settings: null, headSeq: 0, sizeBytes: 0,
  };
  const word = {
    id: 'пара', kind: 'event' as const, kindCount: 2, minutes: 105, minutesCount: 3, touched: 4,
  };

  it('слова движка читаются; негодные и пустые пропускаются; прежний движок — пустой словарь', () => {
    const state = fromEngineState({
      ...ENGINE_EMPTY,
      learned: [
        {
          id: 'пара', kind: 'event', kindCount: 2, minutes: 105, minutesCount: 3, touched: 4,
        },
        {
          id: 'созвон', kind: '', kindCount: 0, minutes: 20, minutesCount: 1, touched: 5,
        },
        {
          id: 'пусто', kind: '', kindCount: 0, minutes: null, minutesCount: 0, touched: 6,
        },
        {
          id: 'чужое', kind: 'food', kindCount: 3, minutes: null, minutesCount: 0, touched: 7,
        },
      ],
    });
    expect(state.learned).toEqual([word, {
      id: 'созвон', kind: undefined, kindCount: 0, minutes: 20, minutesCount: 1, touched: 5,
    }]);
    expect(fromEngineState(ENGINE_EMPTY).learned).toEqual([]);
  });

  it('новое слово уходит целиком, правка — только изменившейся парой, пропавшее — удалением', () => {
    const empty = createEmptyPlannerState();
    const one: PlannerState = { ...empty, learned: [word] };
    expect(diffChanges(empty, one)).toEqual([{
      learned: {
        id: 'пара', kind: 'event', kindCount: 2, minutes: 105, minutesCount: 3, touched: 4,
      },
    }]);
    expect(diffChanges(one, { ...one, learned: [{ ...word }] })).toEqual([]);
    // Счётчик длительности вырос: тип не уходит и не затрёт правку типа с другого устройства
    expect(diffChanges(one, { ...one, learned: [{ ...word, minutesCount: 4, touched: 5 }] }))
      .toEqual([{ learned: { id: 'пара', minutes: 105, minutesCount: 4, touched: 5 } }]);
    // Тип разучен: пустая строка и ноль
    expect(diffChanges(one, { ...one, learned: [{ ...word, kind: undefined, kindCount: 0 }] }))
      .toEqual([{ learned: { id: 'пара', kind: '', kindCount: 0 } }]);
    expect(diffChanges(one, { ...one, learned: [{ ...word, minutes: undefined, minutesCount: 0 }] }))
      .toEqual([{ learned: { id: 'пара', minutes: null, minutesCount: 0 } }]);
    // Сброс словаря и вытеснение — надгробия по слову
    const two: PlannerState = {
      ...one,
      learned: [word, {
        id: 'зал', kind: 'event', kindCount: 3, minutesCount: 0, touched: 6,
      }],
    };
    expect(diffChanges(two, { ...two, learned: [] }))
      .toEqual([{ learned: { id: 'пара', deleted: true } }, { learned: { id: 'зал', deleted: true } }]);
    // Перенос данных этапа 1 словаря не несёт
    expect(legacyToChanges(empty, 'web1').some((change) => 'learned' in change)).toBe(false);
  });
});

describe('планировщик ↔ движок: история ввода текстом', () => {
  const ENGINE_EMPTY: EngineState = {
    tasks: [], events: [], lists: [], settings: null, headSeq: 0, sizeBytes: 0,
  };
  const line = {
    id: 'q01', text: 'созвон завтра 16:00', count: 2, touched: 4,
  };
  const hidden = {
    id: 'h02', text: 'созвон 16:00', count: 0, touched: 5, isHidden: true,
  };

  it('записи движка читаются; пустые и повторные пропускаются; прежний движок истории не ведёт', () => {
    const engine: EngineState = {
      ...ENGINE_EMPTY,
      quickLines: [
        { ...line, hidden: false },
        {
          id: 'h02', text: 'созвон 16:00', count: 0, touched: 5, hidden: true,
        },
        {
          id: 'q03', text: '  ', count: 1, touched: 6, hidden: false,
        },
        {
          id: 'q01', text: 'дубль', count: 1, touched: 7, hidden: false,
        },
      ],
    };
    expect(fromEngineState(engine).quickLines).toEqual([line, hidden]);
    expect(hasEngineQuickLines(engine)).toBe(true);
    expect(hasEngineQuickLines({ ...ENGINE_EMPTY, quickLines: [] })).toBe(true);
    expect(fromEngineState(ENGINE_EMPTY).quickLines).toEqual([]);
    expect(hasEngineQuickLines(ENGINE_EMPTY)).toBe(false);
  });

  it('запись уходит целиком, неизменённая не уходит, пропавшая — надгробием', () => {
    const empty = createEmptyPlannerState();
    const two: PlannerState = { ...empty, quickLines: [line, hidden] };
    expect(diffChanges(empty, two)).toEqual([
      {
        quickLine: {
          id: 'q01', text: 'созвон завтра 16:00', count: 2, touched: 4, hidden: false,
        },
      },
      {
        quickLine: {
          id: 'h02', text: 'созвон 16:00', count: 0, touched: 5, hidden: true,
        },
      },
    ]);
    expect(diffChanges(two, { ...two, quickLines: [{ ...hidden }, { ...line }] })).toEqual([]);
    expect(diffChanges(two, { ...two, quickLines: [{ ...line, count: 3, touched: 9 }, hidden] })).toEqual([{
      quickLine: {
        id: 'q01', text: 'созвон завтра 16:00', count: 3, touched: 9, hidden: false,
      },
    }]);
    // «Забыть», вытеснение и сброс — надгробия по записи
    expect(diffChanges(two, { ...two, quickLines: [hidden] })).toEqual([{ quickLine: { id: 'q01', deleted: true } }]);
    expect(diffChanges(two, { ...two, quickLines: [] }))
      .toEqual([{ quickLine: { id: 'q01', deleted: true } }, { quickLine: { id: 'h02', deleted: true } }]);
    // Запись и её строка истории уходят одной пачкой: история не мешает остальным правкам
    const withTask = diffChanges(empty, {
      ...two,
      tasks: [{
        id: 't1', name: 'созвон', description: '', steps: [], status: 'queue', project: '', rank: 0,
      }],
    });
    expect(withTask.map((change) => Object.keys(change)[0])).toEqual(['task', 'quickLine', 'quickLine']);
    // Перенос данных этапа 1 истории не несёт
    expect(legacyToChanges(empty, 'web1').some((change) => 'quickLine' in change)).toBe(false);
  });
});

describe('планировщик ↔ движок: описание ряда и одного дня', () => {
  const SERIES = {
    id: 'e1',
    name: 'Йога',
    start: '18:00',
    end: '19:00',
    description: 'Взять коврик',
    repeat: {
      kind: 'weekly' as const, interval: 1, weekdays: [1], startDay: '2026-10-12',
    },
  };

  it('ряд с описанием первого дня уходит двумя созданиями разных объектов: ряд без описания и день с описанием', () => {
    const before = createEmptyPlannerState();
    const after = structuredClone(before);
    const own = addEntry(after, 'event', SERIES, 'one', '2026-10-12')!;
    const changes = diffChanges(before, after);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      event: {
        id: 'e1',
        description: '',
        repeat: { kind: 'weekly', weekdays: [1], startDay: '2026-10-12' },
        occurrences: [{ day: '2026-10-12', excluded: true, done: false, doneSteps: [] }],
        origin: null,
      },
    });
    expect(changes[1]).toMatchObject({
      event: {
        id: own.id,
        description: 'Взять коврик',
        day: '2026-10-12',
        repeat: null,
        occurrences: [],
        origin: { seriesId: 'e1', day: '2026-10-12' },
      },
    });
  });

  it('описание «для всех» у экземпляра — одно поле ряда; «только этот день» — отметка дня и новая запись', () => {
    const before = createEmptyPlannerState();
    addEntry(before, 'event', SERIES, 'all', '2026-10-12');
    const instance = eventInstance(before.events[0], '2026-10-19');

    const all = structuredClone(before);
    setDescription(all, 'event', instance, 'Новый зал', 'all');
    const allChanges = diffChanges(before, all);
    expect(allChanges).toHaveLength(1);
    const allEvent = allChanges[0].event as Record<string, unknown>;
    expect(allEvent).toMatchObject({ id: 'e1', description: 'Новый зал' });
    expect(allEvent).not.toHaveProperty('occurrences');
    expect(allEvent).not.toHaveProperty('name');

    const one = structuredClone(before);
    const own = setDescription(one, 'event', instance, 'Только сегодня', 'one')!;
    const oneChanges = diffChanges(before, one);
    expect(oneChanges).toHaveLength(2);
    const seriesEvent = oneChanges[0].event as Record<string, unknown>;
    expect(seriesEvent).toMatchObject({
      id: 'e1', occurrences: [{ day: '2026-10-19', excluded: true, done: false, doneSteps: [] }],
    });
    expect(seriesEvent).not.toHaveProperty('description');
    expect(oneChanges[1]).toMatchObject({
      event: { id: own.id, description: 'Только сегодня', day: '2026-10-19', origin: { seriesId: 'e1' } },
    });
  });
});
