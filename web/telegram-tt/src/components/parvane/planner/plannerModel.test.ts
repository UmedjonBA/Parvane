import { describe, expect, it } from 'vitest';

import type { PlannerState, PlannerTask } from './plannerModel';

import {
  countConflicts, createEmptyPlannerState, findSlots, fitsBookingWindow, getDayAvailability, getDayLoad,
  getEventsForDay, getNutrientStatistics, getNutrientStatus, getNutrientTotal, getTimeStatistics, makeFoodEntry,
  normalizePlannerState, validateEvent, validateTask,
} from './plannerModel';

// 8 октября 2026 — четверг
const TODAY = '2026-10-08';

function task(patch: Partial<PlannerTask>): PlannerTask {
  return {
    id: 1, name: 'Задача', description: '', steps: [], status: 'queue', project: '', rank: 1, ...patch,
  };
}

function stateWith(patch: Partial<PlannerState>): PlannerState {
  return { ...createEmptyPlannerState(), ...patch };
}

describe('планировщик: события и загрузка дня', () => {
  const state = stateWith({
    events: [
      { id: 10, name: 'Созвон', start: '10:00', end: '10:30', weekdays: [1, 2, 3, 4, 5] },
      { id: 11, name: 'Ужин', start: '20:30', end: '22:00', day: '2026-10-22' },
    ],
    tasks: [
      task({ id: 1, day: TODAY, start: '10:15', minutes: 30 }),
      task({ id: 2, day: TODAY, minutes: 90 }),
      task({ id: 3, day: TODAY }),
    ],
  });

  it('повтор по дням недели и разовая дата', () => {
    expect(getEventsForDay(state, TODAY).map(({ id }) => id)).toEqual([10]);
    expect(getEventsForDay(state, '2026-10-10')).toEqual([]);
    expect(getEventsForDay(state, '2026-10-22').map(({ id }) => id)).toEqual([10, 11]);
  });

  it('загрузка — события плюс оценки задач, без оценки не считается', () => {
    expect(getDayLoad(state, TODAY)).toBe(30 + 30 + 90);
  });

  it('пересечение времени считается парами', () => {
    expect(countConflicts(state, TODAY)).toBe(1);
    expect(countConflicts(state, '2026-10-09')).toBe(0);
  });

  it('свободные окна 09–21 и группа пересекающихся дел', () => {
    const availability = getDayAvailability(state, TODAY);
    expect(availability.free).toEqual([{ start: 540, end: 600 }, { start: 645, end: 1260 }]);
    expect(availability.groups).toHaveLength(1);
    expect(availability.groups[0].items).toHaveLength(2);
    expect(availability.freeMinutes).toBe(60 + 615);
  });
});

describe('планировщик: поиск окна и проверки ввода', () => {
  it('окно ищется с запасом 15 минут и мимо обеда', () => {
    const state = stateWith({
      tasks: [task({ id: 1, day: TODAY, start: '09:00', minutes: 60 }), task({ id: 2, minutes: 120 })],
    });
    const [first] = findSlots(state, state.tasks[1], TODAY, TODAY);
    expect(first).toEqual({ day: TODAY, start: '10:15', end: '12:15' });
  });

  it('день сверх бюджета пропускается, дедлайн ограничивает поиск', () => {
    const state = stateWith({
      budget: 120,
      tasks: [task({ id: 1, day: TODAY, minutes: 100 }), task({ id: 2, minutes: 60, due: '2026-10-09' })],
    });
    expect(findSlots(state, state.tasks[1], TODAY, TODAY).map(({ day }) => day)).toEqual(['2026-10-09']);
  });

  it('задача без оценки окна не получает', () => {
    expect(findSlots(createEmptyPlannerState(), task({}), TODAY, TODAY)).toEqual([]);
  });

  it('проверки задачи', () => {
    expect(validateTask({ name: ' ' })).toBe('name');
    expect(validateTask({ name: 'a', minutes: 3 })).toBe('minutes');
    expect(validateTask({ name: 'a', start: '10:00' })).toBe('startNeedsDayAndMinutes');
    expect(validateTask({ name: 'a', day: TODAY, start: '23:30', minutes: 60 })).toBe('pastMidnight');
    expect(validateTask({ name: 'a', day: '2026-10-10', due: TODAY })).toBe('dayAfterDue');
    expect(validateTask({ name: 'a', day: TODAY, start: '10:00', minutes: 60 })).toBeUndefined();
  });

  it('проверки события', () => {
    expect(validateEvent({ name: 'a', start: '11:00', end: '10:00', day: TODAY })).toBe('time');
    expect(validateEvent({ name: 'a', start: '10:00', end: '11:00' })).toBe('repeat');
    expect(validateEvent({ name: 'a', start: '10:00', end: '11:00', weekdays: [1] })).toBeUndefined();
  });

  it('задача из свободного окна обязана в него поместиться', () => {
    const state = createEmptyPlannerState();
    const window = { day: TODAY, start: 600, end: 660 };
    expect(fitsBookingWindow(state, window, { day: TODAY, start: '10:00', minutes: 60 })).toBe(true);
    expect(fitsBookingWindow(state, window, { day: TODAY, start: '10:30', minutes: 60 })).toBe(false);
    expect(fitsBookingWindow(state, window, { day: '2026-10-09', start: '10:00', minutes: 30 })).toBe(false);
  });
});

describe('планировщик: питание', () => {
  it('запись на 100 г пересчитывается по весу, неизвестное остаётся неизвестным', () => {
    const entry = makeFoodEntry({
      name: ' Творог ', meal: 'breakfast', isPer100: true, grams: 250, values: { kcal: 120, protein: 18 },
    });
    expect(entry).toMatchObject({ name: 'Творог', kcal: 300, protein: 45, grams: 250 });
    expect(entry.fat).toBeUndefined();
    expect(entry.per100).toEqual({ kcal: 120, protein: 18 });
  });

  it('пропуски не считаются нулём; статус дня — по завершённости и цели', () => {
    const state = stateWith({
      nutrition: {
        [TODAY]: {
          entries: [
            { name: 'a', meal: 'lunch', kcal: 1000, protein: 60 },
            { name: 'b', meal: 'dinner', kcal: 1050 },
          ],
          isComplete: true,
        },
      },
    });
    expect(getNutrientTotal(state, TODAY, 'protein')).toEqual({ value: 60, missing: 1, count: 2 });
    expect(getNutrientStatus(state, TODAY, 'kcal')).toBe('ok');
    expect(getNutrientStatus(state, TODAY, 'protein')).toBe('incomplete');
    expect(getNutrientStatus(state, '2026-10-07', 'kcal')).toBe('none');
    state.nutrition[TODAY].isComplete = false;
    expect(getNutrientStatus(state, TODAY, 'kcal')).toBe('open');
  });

  it('цели завершённого дня не меняются при смене текущих целей', () => {
    const state = stateWith({
      nutrition: {
        [TODAY]: {
          entries: [{ name: 'a', meal: 'other', kcal: 2000 }],
          isComplete: true,
          goal: { target: 2000, tolerance: 100 },
        },
      },
      calorieGoal: { target: 3000, tolerance: 100 },
    });
    expect(getNutrientStatus(state, TODAY, 'kcal')).toBe('ok');
    const stat = getNutrientStatistics(state, [TODAY, '2026-10-09'], 'kcal', TODAY);
    expect(stat).toMatchObject({ sum: 2000, inGoal: 1, average: 2000, goalLow: 1900, goalHigh: 2100 });
  });
});

describe('планировщик: статистика времени и хранение', () => {
  it('время по спискам и событиям; скрытая группа не входит в сумму', () => {
    const state = stateWith({
      projects: ['', 'Учёба'],
      events: [{ id: 5, name: 'e', start: '10:00', end: '11:00', day: TODAY }],
      tasks: [
        task({ id: 1, day: TODAY, minutes: 30, project: 'Учёба' }),
        task({ id: 2, day: TODAY }),
        task({ id: 3, minutes: 500 }),
      ],
    });
    const all = getTimeStatistics(state, [TODAY], new Set());
    expect(all.total).toBe(90);
    expect(all.unrated).toBe(1);
    expect(getTimeStatistics(state, [TODAY], new Set(['Учёба'])).total).toBe(60);
  });

  it('негодное сохранённое состояние — пустой планировщик, годное приводится к форме', () => {
    expect(normalizePlannerState(undefined)).toEqual(createEmptyPlannerState());
    expect(normalizePlannerState({ version: 2, tasks: [] })).toEqual(createEmptyPlannerState());
    const restored = normalizePlannerState({
      version: 1,
      tasks: [{ id: 7, name: 'x', status: 'nonsense', project: 'Дом', day: 'вчера', minutes: 2 }],
      events: [{ id: 9, name: 'e', start: '25:00', end: '26:00' }],
      projects: ['Работа'],
    });
    expect(restored.tasks[0]).toMatchObject({ id: 7, status: 'queue', project: 'Дом', description: '', steps: [] });
    expect(restored.tasks[0].day).toBeUndefined();
    expect(restored.tasks[0].minutes).toBeUndefined();
    expect(restored.events).toEqual([]);
    expect(restored.projects).toEqual(['', 'Работа', 'Дом']);
    expect(restored.nextId).toBe(8);
  });
});
