import { describe, expect, it } from 'vitest';

import type {
  PlannerEvent, PlannerRepeat, PlannerState, PlannerTask,
} from './plannerModel';

import {
  createEmptyPlannerState, detachInstance, eventInstance, getEventsForDay, getTasksForDay, taskInstance,
} from './plannerModel';
import {
  addEntry, detachWithDescription, firstSeriesDay, getDescriptionScope, setDescription, shareDescription,
} from './plannerSeriesEdit';

// 12 октября 2026 — понедельник
const MONDAY = '2026-10-12';
const NEXT_MONDAY = '2026-10-19';
const WEEKLY: PlannerRepeat = {
  kind: 'weekly', interval: 1, weekdays: [1], startDay: MONDAY,
};

function stateWith(patch: Partial<PlannerState>): PlannerState {
  return { ...createEmptyPlannerState(), ...patch };
}

function event(patch: Partial<PlannerEvent> = {}): PlannerEvent {
  return {
    id: 'e1', name: 'Йога', start: '18:00', end: '19:00', repeat: WEEKLY, ...patch,
  };
}

function task(patch: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: 't1',
    name: 'Зарядка',
    description: '',
    steps: [],
    status: 'queue',
    project: '',
    rank: 1,
    start: '10:00',
    minutes: 15,
    repeat: { kind: 'daily', interval: 1, startDay: MONDAY },
    ...patch,
  };
}

function descriptionsOn(state: PlannerState, day: string) {
  return [...getEventsForDay(state, day), ...getTasksForDay(state, day)].map((item) => item.description || '');
}

describe('планировщик: описание ряда — всех повторов или одного дня', () => {
  it('новый ряд с описанием «для всех»: одна запись, описание у каждого повтора', () => {
    const state = stateWith({});
    const detached = addEntry(state, 'event', event({ description: 'Взять коврик' }), 'all', MONDAY);
    expect(detached).toBeUndefined();
    expect(state.events).toHaveLength(1);
    expect(descriptionsOn(state, MONDAY)).toEqual(['Взять коврик']);
    expect(descriptionsOn(state, NEXT_MONDAY)).toEqual(['Взять коврик']);
  });

  it('новый ряд с описанием «только этого дня»: ряд без описания, первый день — отделённой копией с описанием', () => {
    const state = stateWith({});
    const detached = addEntry(state, 'event', event({ description: 'Взять коврик' }), 'one', MONDAY);
    expect(state.events).toHaveLength(2);
    expect(state.events[0]).toMatchObject({
      id: 'e1', description: undefined, repeat: WEEKLY, occurrences: [{ day: MONDAY, excluded: true }],
    });
    expect(detached).toMatchObject({
      name: 'Йога', description: 'Взять коврик', day: MONDAY, origin: { seriesId: 'e1', day: MONDAY },
    });
    expect(detached!.repeat).toBeUndefined();
    // В первый день — одна запись (копия), через неделю — экземпляр ряда без описания
    expect(descriptionsOn(state, MONDAY)).toEqual(['Взять коврик']);
    expect(descriptionsOn(state, NEXT_MONDAY)).toEqual(['']);
  });

  it('первый день считается по правилу, а не по дате начала: ряд по средам с понедельника', () => {
    const repeat: PlannerRepeat = { ...WEEKLY, weekdays: [3] };
    expect(firstSeriesDay(repeat, MONDAY)).toBe('2026-10-14');
    const state = stateWith({});
    const detached = addEntry(state, 'task', task({ description: 'Первое занятие', repeat }), 'one', MONDAY);
    expect(detached).toMatchObject({ day: '2026-10-14', description: 'Первое занятие', start: '10:00', minutes: 15 });
    expect(state.tasks[0]).toMatchObject({ id: 't1', description: '' });
    expect(descriptionsOn(state, '2026-10-21')).toEqual(['']);
  });

  it('ряд раз в две недели, первая неделя без экземпляра: первый день — через шаг', () => {
    // Начало в среду, день ряда — понедельник: неделя начала экземпляра не даёт
    const repeat: PlannerRepeat = {
      kind: 'weekly', interval: 2, weekdays: [1], startDay: '2026-10-14',
    };
    expect(firstSeriesDay(repeat, MONDAY)).toBe('2026-10-26');
  });

  it('без описания и без первого дня ничего не отделяется, описание не теряется', () => {
    const empty = stateWith({});
    expect(addEntry(empty, 'event', event(), 'one', MONDAY)).toBeUndefined();
    expect(empty.events).toHaveLength(1);
    // Ряд кончается раньше первого экземпляра
    const none: PlannerRepeat = { ...WEEKLY, weekdays: [5], endDay: '2026-10-13' };
    const state = stateWith({});
    expect(addEntry(state, 'event', event({ description: 'Текст', repeat: none }), 'one', MONDAY)).toBeUndefined();
    expect(state.events).toEqual([event({ description: 'Текст', repeat: none })]);
    // Разовая запись создаётся как есть
    const single = stateWith({});
    addEntry(single, 'event', event({ description: 'Текст', repeat: undefined, day: MONDAY }), 'one', MONDAY);
    expect(single.events).toEqual([event({ description: 'Текст', repeat: undefined, day: MONDAY })]);
  });

  it('правка описания у экземпляра: «для всех» — шаблон, отделённые дни хранят своё', () => {
    const state = stateWith({ events: [event({ description: 'Старое' })] });
    detachInstance(state, 'event', 'e1', MONDAY, { description: 'Своё' });
    const instance = eventInstance(state.events[0], NEXT_MONDAY);
    const result = setDescription(state, 'event', instance, 'Новое', 'all');
    expect(result!.id).toBe('e1');
    expect(state.events).toHaveLength(2);
    expect(descriptionsOn(state, MONDAY)).toEqual(['Своё']);
    expect(descriptionsOn(state, NEXT_MONDAY)).toEqual(['Новое']);
    expect(descriptionsOn(state, '2026-10-26')).toEqual(['Новое']);
  });

  it('правка описания у экземпляра: «только этот день» — день отделяется, у ряда описание прежнее', () => {
    const state = stateWith({ tasks: [task({ description: 'Общее' })] });
    const instance = taskInstance(state.tasks[0], '2026-10-13');
    const result = setDescription(state, 'task', instance, 'Только сегодня', 'one');
    expect(result).toMatchObject({
      description: 'Только сегодня', day: '2026-10-13', origin: { seriesId: 't1', day: '2026-10-13' },
    });
    expect(result!.id).not.toBe('t1');
    expect(state.tasks[0].description).toBe('Общее');
    expect(descriptionsOn(state, '2026-10-13')).toEqual(['Только сегодня']);
    expect(descriptionsOn(state, '2026-10-14')).toEqual(['Общее']);
  });

  it('пустое описание у события — отсутствие значения, у задачи — пустая строка', () => {
    const state = stateWith({ events: [event({ description: 'Было' })], tasks: [task({ description: 'Было' })] });
    setDescription(state, 'event', eventInstance(state.events[0], MONDAY), '', 'all');
    setDescription(state, 'task', taskInstance(state.tasks[0], MONDAY), '', 'all');
    expect(state.events[0].description).toBeUndefined();
    expect(state.tasks[0].description).toBe('');
  });

  it('галочка у открытой записи: экземпляр — «для всех», отделённый день — по совпадению с рядом', () => {
    const state = stateWith({ events: [event({ description: 'Общее' })] });
    const series = state.events[0];
    expect(getDescriptionScope(state, 'event', eventInstance(series, MONDAY))).toBe('all');
    // Шаблон ряда и разовая запись — без галочки
    expect(getDescriptionScope(state, 'event', series)).toBeUndefined();
    expect(getDescriptionScope(state, 'event', event({ id: 'e9', repeat: undefined, day: MONDAY }))).toBeUndefined();
    const same = detachInstance(state, 'event', 'e1', MONDAY, { start: '19:00' })!;
    expect(getDescriptionScope(state, 'event', same)).toBe('all');
    const own = detachInstance(state, 'event', 'e1', NEXT_MONDAY, { description: 'Своё' })!;
    expect(getDescriptionScope(state, 'event', own)).toBe('one');
    // Ряд удалён — отделённый день становится обычной разовой записью
    state.events = state.events.filter(({ id }) => id !== 'e1');
    expect(getDescriptionScope(state, 'event', own)).toBeUndefined();
  });

  it('отделённый день: своё описание; «для всех» пишет его и в ряд; перенос описания в ряд', () => {
    const state = stateWith({ events: [event({ description: 'Общее' })] });
    const copy = detachInstance(state, 'event', 'e1', MONDAY, {})!;
    setDescription(state, 'event', copy, 'Только копия', 'one');
    expect(state.events[0].description).toBe('Общее');
    expect(descriptionsOn(state, MONDAY)).toEqual(['Только копия']);
    setDescription(state, 'event', copy, 'И ряду тоже', 'all');
    expect(descriptionsOn(state, MONDAY)).toEqual(['И ряду тоже']);
    expect(descriptionsOn(state, NEXT_MONDAY)).toEqual(['И ряду тоже']);
    // Перенос: копия остаётся отделённой, ряд получает её описание
    setDescription(state, 'event', copy, 'Третье', 'one');
    const current = state.events.find(({ id }) => id === copy.id)!;
    expect(getDescriptionScope(state, 'event', current)).toBe('one');
    expect(shareDescription(state, 'event', current)).toBe(true);
    expect(state.events).toHaveLength(2);
    expect(descriptionsOn(state, NEXT_MONDAY)).toEqual(['Третье']);
    expect(getDescriptionScope(state, 'event', current)).toBe('all');
    expect(shareDescription(state, 'event', event({ id: 'e9', repeat: undefined, day: MONDAY }))).toBe(false);
  });

  it('своё описание дня после правки остальных полей у ряда: день отделяется, если ряд его даёт', () => {
    const state = stateWith({ events: [event()] });
    expect(detachWithDescription(state, 'event', 'e1', NEXT_MONDAY, 'Свой текст')).toMatchObject({
      day: NEXT_MONDAY, description: 'Свой текст',
    });
    expect(detachWithDescription(state, 'event', 'e1', '2026-10-20', 'Нет экземпляра')).toBeUndefined();
    expect(state.events).toHaveLength(2);
  });
});
