import { describe, expect, it } from 'vitest';

import type {
  PlannerEvent, PlannerRepeat, PlannerState, PlannerTask,
} from './plannerModel';

import { createEmptyPlannerState, getEventsForDay, getTasksForDay } from './plannerModel';
import { changeSeriesRule, nearestSeriesDay, sameRepeat } from './plannerSeriesRule';

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

describe('планировщик: смена правила повтора у экземпляра', () => {
  it('сравнение правил: порядок дней недели и пустые значения не важны', () => {
    expect(sameRepeat(undefined, undefined)).toBe(true);
    expect(sameRepeat(WEEKLY, undefined)).toBe(false);
    expect(sameRepeat({ ...WEEKLY, weekdays: [1, 3] }, { ...WEEKLY, weekdays: [3, 1], endDay: undefined })).toBe(true);
    expect(sameRepeat(WEEKLY, { ...WEEKLY, weekdays: [2] })).toBe(false);
    expect(sameRepeat(WEEKLY, { ...WEEKLY, interval: 2 })).toBe(false);
    expect(sameRepeat(WEEKLY, { ...WEEKLY, endDay: '2026-12-01' })).toBe(false);
    expect(sameRepeat(WEEKLY, { ...WEEKLY, count: 3 })).toBe(false);
  });

  it('«это и последующие»: прежние дни по старому правилу, с этого дня — по новому', () => {
    const state = stateWith({ tasks: [task({ repeat: { ...WEEKLY, weekdays: [1, 3] } })] });
    // Отметка прошедшего дня остаётся у прежнего ряда
    state.tasks[0].occurrences = [{ day: MONDAY, done: true }];
    const next: PlannerRepeat = { ...WEEKLY, weekdays: [2, 4] };
    const created = changeSeriesRule(state, 'task', 't1', NEXT_MONDAY, next, 'following')!;
    expect(created.id).not.toBe('t1');
    expect(state.tasks[0].repeat).toMatchObject({ weekdays: [1, 3], startDay: MONDAY, endDay: '2026-10-18' });
    expect(state.tasks[0].occurrences).toEqual([{ day: MONDAY, done: true }]);
    expect(created.repeat).toEqual({ ...next, startDay: NEXT_MONDAY });
    // Первая неделя — понедельник и среда, со второй — вторник и четверг
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-19', '2026-10-20', '2026-10-21',
      '2026-10-22'];
    expect(days.filter((day) => getTasksForDay(state, day).length)).toEqual([
      '2026-10-12', '2026-10-14', '2026-10-20', '2026-10-22',
    ]);
    // День, с которого правили, новому правилу не подходит — карточка открывается на ближайшем
    expect(nearestSeriesDay(created, NEXT_MONDAY)).toBe('2026-10-20');
  });

  it('«это и последующие»: неизменённое число повторов делится, изменённое — берётся как есть', () => {
    const daily: PlannerRepeat = { kind: 'daily', interval: 1, startDay: MONDAY, count: 10 };
    const shared = stateWith({ events: [event({ repeat: daily })] });
    const tail = changeSeriesRule(shared, 'event', 'e1', '2026-10-15', { ...daily, interval: 2 }, 'following')!;
    expect(shared.events[0].repeat).toMatchObject({ endDay: '2026-10-14', count: 3 });
    expect(tail.repeat).toEqual({
      kind: 'daily', interval: 2, startDay: '2026-10-15', count: 7, weekdays: undefined, monthDay: undefined,
      endDay: undefined,
    });
    const own = stateWith({ events: [event({ repeat: daily })] });
    const fresh = changeSeriesRule(own, 'event', 'e1', '2026-10-15', { ...daily, count: 4 }, 'following')!;
    expect(fresh.repeat).toMatchObject({ startDay: '2026-10-15', count: 4 });
  });

  it('«это и последующие» у первого дня ряда — правка всего ряда, без второй записи', () => {
    const state = stateWith({ events: [event()] });
    const result = changeSeriesRule(state, 'event', 'e1', MONDAY, { ...WEEKLY, weekdays: [1, 5] }, 'following')!;
    expect(result.id).toBe('e1');
    expect(state.events).toHaveLength(1);
    expect(state.events[0].repeat).toEqual({ ...WEEKLY, weekdays: [1, 5] });
  });

  it('«все в серии»: правило у всего ряда, отметки дней вне нового правила отбрасываются, поля — в шаблон', () => {
    const state = stateWith({ tasks: [task({ repeat: { ...WEEKLY, weekdays: [1, 3] } })] });
    state.tasks[0].occurrences = [{ day: MONDAY, done: true }, { day: '2026-10-14', excluded: true }];
    const next: PlannerRepeat = { ...WEEKLY, weekdays: [1, 5] };
    const result = changeSeriesRule(state, 'task', 't1', NEXT_MONDAY, next, 'all', { name: 'Бег', day: '2026-10-20' })!;
    expect(result.id).toBe('t1');
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ name: 'Бег', repeat: next, occurrences: [{ day: MONDAY, done: true }] });
    expect(state.tasks[0].day).toBeUndefined();
    expect(getTasksForDay(state, '2026-10-16')).toHaveLength(1);
    expect(getTasksForDay(state, '2026-10-14')).toHaveLength(0);
    expect(nearestSeriesDay(result, NEXT_MONDAY)).toBe(NEXT_MONDAY);
  });

  it('«не повторять с этого дня»: день остаётся разовой записью, следующих нет, прежние на месте', () => {
    const state = stateWith({ tasks: [task()] });
    const single = changeSeriesRule(state, 'task', 't1', '2026-10-14', undefined, 'stop')!;
    expect(single).toMatchObject({ day: '2026-10-14', start: '10:00', origin: { seriesId: 't1', day: '2026-10-14' } });
    expect(single.repeat).toBeUndefined();
    expect(state.tasks[0].repeat).toMatchObject({ startDay: MONDAY, endDay: '2026-10-13' });
    expect(state.tasks[0].occurrences || []).toEqual([]);
    expect(getTasksForDay(state, '2026-10-13')).toHaveLength(1);
    expect(getTasksForDay(state, '2026-10-14').map(({ id }) => id)).toEqual([single.id]);
    expect(getTasksForDay(state, '2026-10-15')).toHaveLength(0);
  });

  it('«не повторять» у первого дня: ряда больше нет, остаётся разовая запись', () => {
    const state = stateWith({ events: [event()] });
    const single = changeSeriesRule(state, 'event', 'e1', MONDAY, undefined, 'stop', { name: 'Йога один раз' })!;
    expect(state.events).toEqual([single]);
    expect(single).toMatchObject({ name: 'Йога один раз', day: MONDAY });
    // Разовая копия встаёт на день, выбранный в карточке
    const moved = stateWith({ events: [event()] });
    expect(changeSeriesRule(moved, 'event', 'e1', NEXT_MONDAY, undefined, 'stop', { day: '2026-10-21' }))
      .toMatchObject({ day: '2026-10-21', origin: { seriesId: 'e1', day: NEXT_MONDAY } });
    expect(getEventsForDay(moved, NEXT_MONDAY)).toHaveLength(0);
    expect(getEventsForDay(moved, MONDAY)).toHaveLength(1);
    expect(getEventsForDay(state, NEXT_MONDAY)).toHaveLength(0);
  });

  it('«только этот день без повтора»: день отделён, ряд идёт дальше', () => {
    const state = stateWith({ events: [event()] });
    const single = changeSeriesRule(state, 'event', 'e1', NEXT_MONDAY, undefined, 'one')!;
    expect(single.repeat).toBeUndefined();
    expect(state.events[0].repeat).toEqual(WEEKLY);
    expect(getEventsForDay(state, NEXT_MONDAY).map(({ id }) => id)).toEqual([single.id]);
    expect(getEventsForDay(state, '2026-10-26').map(({ id }) => id)).toEqual(['e1']);
  });

  it('у разовой записи менять нечего', () => {
    const state = stateWith({ events: [event({ repeat: undefined, day: MONDAY })] });
    expect(changeSeriesRule(state, 'event', 'e1', MONDAY, WEEKLY, 'all')).toBeUndefined();
    expect(nearestSeriesDay(state.events[0], MONDAY)).toBeUndefined();
  });
});
