import { describe, expect, it } from 'vitest';

import type { PlannerState, PlannerTask } from './plannerModel';

import {
  countConflicts, createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, detachInstance, excludeInstance, expandRepeat,
  findSlots, fitsBookingWindow, getDayAvailability, getDayLoad, getEligibleTasks, getEventsForDay,
  getGoalRecordForDay, getNutrientStatistics, getNutrientStatus, getNutrientTotal, getOrderedGroup, getTasksForDay,
  getTimeStatistics, makeFoodEntry, moveTask, nextOpenInstance, normalizePlannerState, occursOn, removeSeries,
  setOccurrence, setTaskDone, setTaskStepDone, splitSeries, truncateSeries, validateEvent, validateGoalRecord,
  validateRepeat, validateSettings, validateTask,
} from './plannerModel';

// 8 октября 2026 — четверг
const TODAY = '2026-10-08';

function task(patch: Partial<PlannerTask>): PlannerTask {
  return {
    id: '1', name: 'Задача', description: '', steps: [], status: 'queue', project: '', rank: 1, ...patch,
  };
}

function stateWith(patch: Partial<PlannerState>): PlannerState {
  return { ...createEmptyPlannerState(), ...patch };
}

describe('планировщик: события и загрузка дня', () => {
  const state = stateWith({
    events: [
      {
        id: '10',
        name: 'Созвон',
        start: '10:00',
        end: '10:30',
        repeat: { kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5], startDay: '' },
      },
      { id: '11', name: 'Ужин', start: '20:30', end: '22:00', day: '2026-10-22' },
    ],
    tasks: [
      task({ id: '1', day: TODAY, start: '10:15', minutes: 30 }),
      task({ id: '2', day: TODAY, minutes: 90 }),
      task({ id: '3', day: TODAY }),
    ],
  });

  it('повтор по дням недели и разовая дата', () => {
    expect(getEventsForDay(state, TODAY).map(({ id }) => id)).toEqual(['10']);
    expect(getEventsForDay(state, '2026-10-10')).toEqual([]);
    expect(getEventsForDay(state, '2026-10-22').map(({ id }) => id)).toEqual(['10', '11']);
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
      tasks: [task({ id: '1', day: TODAY, start: '09:00', minutes: 60 }), task({ id: '2', minutes: 120 })],
    });
    const [first] = findSlots(state, state.tasks[1], TODAY, TODAY);
    expect(first).toEqual({ day: TODAY, start: '10:15', end: '12:15' });
  });

  it('день сверх бюджета пропускается, дедлайн ограничивает поиск', () => {
    const state = stateWith({
      budget: 120,
      tasks: [task({ id: '1', day: TODAY, minutes: 100 }), task({ id: '2', minutes: 60, due: '2026-10-09' })],
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
    expect(validateEvent({
      name: 'a', start: '10:00', end: '11:00', repeat: { kind: 'weekly', interval: 1, weekdays: [1], startDay: '' },
    })).toBeUndefined();
    expect(validateEvent({
      name: 'a', start: '10:00', end: '11:00', repeat: { kind: 'daily', interval: 1, startDay: '' },
    })).toBe('startDay');
  });

  it('задача из свободного окна обязана в него поместиться', () => {
    const state = createEmptyPlannerState();
    const window = { day: TODAY, start: 600, end: 660 };
    expect(fitsBookingWindow(state, window, { day: TODAY, start: '10:00', minutes: 60 })).toBe(true);
    expect(fitsBookingWindow(state, window, { day: TODAY, start: '10:30', minutes: 60 })).toBe(false);
    expect(fitsBookingWindow(state, window, { day: '2026-10-09', start: '10:00', minutes: 30 })).toBe(false);
  });
});

describe('планировщик: настройки дня и порядок очереди (T014)', () => {
  it('окна дня, перерыв и запас берутся из настроек', () => {
    const state = stateWith({
      settings: {
        dayStart: 480, dayEnd: 1080, lunchStart: 0, lunchEnd: 0, margin: 0,
      },
      tasks: [task({ id: '1', day: TODAY, start: '08:00', minutes: 60 }), task({ id: '2', minutes: 120 })],
    });
    expect(getDayAvailability(state, TODAY).free).toEqual([{ start: 540, end: 1080 }]);
    // Без перерыва и запаса окно начинается сразу после задачи
    expect(findSlots(state, state.tasks[1], TODAY, TODAY)[0]).toEqual({ day: TODAY, start: '09:00', end: '11:00' });
    state.settings = {
      dayStart: 480, dayEnd: 1080, lunchStart: 540, lunchEnd: 600, margin: 30,
    };
    expect(findSlots(state, state.tasks[1], TODAY, TODAY)[0]).toEqual({ day: TODAY, start: '10:00', end: '12:00' });
  });

  it('проверки настроек', () => {
    expect(validateSettings(DEFAULT_PLANNER_SETTINGS)).toBeUndefined();
    expect(validateSettings({ ...DEFAULT_PLANNER_SETTINGS, dayStart: 1260 })).toBe('window');
    expect(validateSettings({ ...DEFAULT_PLANNER_SETTINGS, lunchStart: 480, lunchEnd: 600 })).toBe('lunch');
    expect(validateSettings({ ...DEFAULT_PLANNER_SETTINGS, lunchStart: 0, lunchEnd: 0 })).toBeUndefined();
    expect(validateSettings({ ...DEFAULT_PLANNER_SETTINGS, margin: 181 })).toBe('margin');
  });

  it('сохранённое без настроек или с негодными получает значения макета', () => {
    expect(normalizePlannerState({ version: 1, tasks: [] }).settings).toEqual(DEFAULT_PLANNER_SETTINGS);
    const restored = normalizePlannerState({
      version: 1, tasks: [], settings: { dayStart: 600, dayEnd: 1200, lunchStart: 0, lunchEnd: 0, margin: 10 },
    });
    expect(restored.settings).toEqual({
      dayStart: 600, dayEnd: 1200, lunchStart: 0, lunchEnd: 0, margin: 10,
    });
    expect(normalizePlannerState({ version: 1, tasks: [], settings: { dayStart: 'x' } }).settings)
      .toEqual(DEFAULT_PLANNER_SETTINGS);
    expect(normalizePlannerState({ version: 1, tasks: [], settings: { dayStart: 1300 } }).settings)
      .toEqual(DEFAULT_PLANNER_SETTINGS);
  });

  it('стрелки меняют задачу местами с соседом того же списка и статуса, у края — ничего', () => {
    const state = stateWith({
      tasks: [
        task({ id: '1', rank: 0 }),
        task({ id: '2', rank: 0 }),
        task({ id: '3', rank: 0, status: 'active' }),
        task({ id: '4', rank: 0, project: 'Дом' }),
      ],
    });
    expect(getOrderedGroup(state, state.tasks[0]).map(({ id }) => id)).toEqual(['1', '2']);
    expect(moveTask(state, '1', -1)).toBe(false);
    expect(moveTask(state, '2', -1)).toBe(true);
    expect(getOrderedGroup(state, state.tasks[0]).map(({ id }) => id)).toEqual(['2', '1']);
    expect(moveTask(state, '2', 1)).toBe(true);
    expect(getOrderedGroup(state, state.tasks[0]).map(({ id }) => id)).toEqual(['1', '2']);
    expect(moveTask(state, '3', 1)).toBe(false);
    expect(moveTask(state, '99', 1)).toBe(false);
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
            { id: 'a', name: 'a', meal: 'lunch', kcal: 1000, protein: 60 },
            { id: 'b', name: 'b', meal: 'dinner', kcal: 1050 },
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
          entries: [{ id: 'a', name: 'a', meal: 'other', kcal: 2000 }],
          isComplete: true,
          fixedGoals: { kcal: { target: 2000, tolerance: 100 } },
        },
      },
      goals: { kcal: { target: 3000, tolerance: 100 } },
    });
    expect(getNutrientStatus(state, TODAY, 'kcal')).toBe('ok');
    const stat = getNutrientStatistics(state, [TODAY, '2026-10-09'], 'kcal', TODAY);
    expect(stat).toMatchObject({ sum: 2000, inGoal: 1, average: 2000, goalLow: 1900, goalHigh: 2100 });
    // SC-005: правка списка целей задним числом завершённый день не переоценивает
    state.goalPeriods.push({
      id: 'g', startDay: TODAY, endDay: TODAY, goals: { kcal: { target: 1000, tolerance: 50 } },
    });
    expect(getNutrientStatus(state, TODAY, 'kcal')).toBe('ok');
  });
});

// ── spec 011: повторы ────────────────────────────────────────────────────────

describe('планировщик: повторяющиеся события и задачи (spec 011)', () => {
  const weekly = (weekdays: number[], startDay: string, extra = {}) => ({
    kind: 'weekly' as const, interval: 1, weekdays, startDay, ...extra,
  });

  it('SC-001: еженедельный ряд по понедельникам и средам — весь ноябрь, до начала ряда ничего', () => {
    const repeat = weekly([1, 3], '2026-10-12');
    expect(expandRepeat(repeat, '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18',
      '2026-11-23', '2026-11-25', '2026-11-30',
    ]);
    expect(expandRepeat(repeat, '2026-10-01', '2026-10-11')).toEqual([]);
    // Ряд с середины недели: понедельник той же недели не порождается, счёт идёт с первого экземпляра
    expect(expandRepeat(weekly([1, 3], '2026-10-14', { count: 2 }), '2026-10-01', '2026-10-31'))
      .toEqual(['2026-10-14', '2026-10-19']);
    // Шаг две недели
    expect(expandRepeat({ ...weekly([1], '2026-10-12'), interval: 2 }, '2026-10-01', '2026-11-30'))
      .toEqual(['2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23']);
  });

  it('SC-001: ежемесячно 31-го — в коротком месяце последний день; ежегодно 29 февраля — 28-го', () => {
    const monthly = { kind: 'monthly' as const, interval: 1, startDay: '2026-10-31' };
    expect(expandRepeat(monthly, '2026-11-01', '2027-03-31')).toEqual([
      '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31',
    ]);
    expect(occursOn(monthly, '2028-02-29')).toBe(true);
    expect(occursOn({ ...monthly, monthDay: 20, startDay: '2026-10-01' }, '2026-11-20')).toBe(true);
    expect(occursOn({ ...monthly, interval: 3 }, '2027-01-31')).toBe(true);
    expect(occursOn({ ...monthly, interval: 3 }, '2026-12-31')).toBe(false);
    const yearly = { kind: 'yearly' as const, interval: 1, startDay: '2028-02-29' };
    expect(expandRepeat(yearly, '2028-01-01', '2030-12-31')).toEqual(['2028-02-29', '2029-02-28', '2030-02-28']);
  });

  it('SC-001: ежедневно с числом повторов и датой конца; исключённые считаются в K', () => {
    const daily = { kind: 'daily' as const, interval: 1, startDay: '2026-10-01', count: 10 };
    expect(expandRepeat(daily, '2026-09-01', '2026-12-31')).toHaveLength(10);
    expect(occursOn(daily, '2026-10-10')).toBe(true);
    expect(occursOn(daily, '2026-10-11')).toBe(false);
    expect(expandRepeat({ ...daily, interval: 3, count: undefined, endDay: '2026-10-10' }, '2026-09-01', '2026-12-31'))
      .toEqual(['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10']);
    expect(validateRepeat({ ...daily, interval: 0 })).toBe('interval');
    expect(validateRepeat({ ...daily, endDay: '2026-09-01' })).toBe('endDay');
    expect(validateRepeat(weekly([], TODAY))).toBe('weekdays');
    expect(validateRepeat({ ...daily, count: 1000 })).toBe('count');
  });

  it('экземпляры задачи-ряда: выполнение одного дня не трогает следующий, шаги по дню, ближайший невыполненный', () => {
    const state = stateWith({
      tasks: [task({
        id: 's', name: 'Зарядка', minutes: 15, steps: [{ text: 'а', isDone: false }, { text: 'б', isDone: false }],
        repeat: { kind: 'daily', interval: 1, startDay: '2026-10-01', count: 10 },
      })],
    });
    expect(getTasksForDay(state, TODAY)).toHaveLength(1);
    expect(getTasksForDay(state, '2026-10-20')).toHaveLength(0);
    const instance = getTasksForDay(state, TODAY)[0];
    expect(instance).toMatchObject({ id: 's', instanceDay: TODAY, day: TODAY, status: 'queue' });
    setTaskDone(state, instance, true);
    setTaskStepDone(state, instance, 1, true);
    expect(getTasksForDay(state, TODAY)[0])
      .toMatchObject({ status: 'done', steps: [{ isDone: false }, { isDone: true }] });
    expect(getTasksForDay(state, '2026-10-09')[0])
      .toMatchObject({ status: 'queue', steps: [{ isDone: false }, { isDone: false }] });
    expect(nextOpenInstance(state.tasks[0], TODAY)?.instanceDay).toBe('2026-10-09');
    // В списке задач — одна строка, ближайший невыполненный экземпляр
    expect(getEligibleTasks(state, TODAY).map((t) => t.instanceDay)).toEqual(['2026-10-09']);
    setTaskDone(state, getTasksForDay(state, TODAY)[0], false);
    expect(getTasksForDay(state, TODAY)[0].status).toBe('queue');
    // Загрузка и поиск окна учитывают экземпляры
    expect(getDayLoad(state, '2026-10-09')).toBe(15);
  });

  it('«только это»: отделённая копия с происхождением, день исключён у ряда; удаление ряда её не трогает', () => {
    const state = stateWith({
      events: [{ id: 'e', name: 'Бассейн', start: '19:00', end: '20:00', repeat: weekly([1, 3], '2026-10-12') }],
    });
    const detached = detachInstance(
      state, 'event', 'e', '2026-10-14', { start: '20:00', end: '21:00', day: '2026-10-15' },
    )!;
    expect(detached).toMatchObject({ origin: { seriesId: 'e', day: '2026-10-14' }, day: '2026-10-15', start: '20:00' });
    expect(detached.repeat).toBeUndefined();
    expect(getEventsForDay(state, '2026-10-14')).toEqual([]);
    expect(getEventsForDay(state, '2026-10-15').map((e) => e.id)).toEqual([detached.id]);
    expect(getEventsForDay(state, '2026-10-19').map((e) => e.id)).toEqual(['e']);
    excludeInstance(state, 'event', 'e', '2026-10-19');
    expect(getEventsForDay(state, '2026-10-19')).toEqual([]);
    removeSeries(state, 'event', 'e');
    expect(state.events.map((e) => e.id)).toEqual([detached.id]);
  });

  it('«это и последующие»: старый ряд заканчивается днём раньше с прежними отметками, новый — с этого дня', () => {
    const state = stateWith({
      tasks: [task({
        id: 's', name: 'Бассейн', start: '19:00', minutes: 60, repeat: weekly([1], '2026-10-12', { count: 6 }),
      })],
    });
    setOccurrence(state, 'task', 's', '2026-10-19', { done: true });
    setOccurrence(state, 'task', 's', '2026-11-09', { done: true });
    const created = splitSeries(state, 'task', 's', '2026-11-02', { start: '20:00' })!;
    expect(state.tasks[0].repeat).toMatchObject({ endDay: '2026-11-01', count: 3 });
    expect(state.tasks[0].occurrences).toEqual([{ day: '2026-10-19', done: true }]);
    expect(created.repeat).toMatchObject({ kind: 'weekly', startDay: '2026-11-02', count: 3 });
    expect(created.start).toBe('20:00');
    expect(getTasksForDay(state, '2026-10-26')[0]).toMatchObject({ id: 's', start: '19:00' });
    expect(getTasksForDay(state, '2026-11-02')[0]).toMatchObject({ id: created.id, start: '20:00' });
    expect(getTasksForDay(state, '2026-11-09')[0]).toMatchObject({ id: created.id, status: 'queue' });
    // «Удалить это и последующие» — только обрезание
    truncateSeries(state, 'task', created.id, '2026-11-16');
    expect(getTasksForDay(state, '2026-11-16')).toEqual([]);
    expect(getTasksForDay(state, '2026-11-09')).toHaveLength(1);
    // Разделение на первом дне ряда — правка всего ряда
    const whole = splitSeries(state, 'task', 's', '2026-10-12', { name: 'Плавание' })!;
    expect(whole.id).toBe('s');
    expect(state.tasks.find((t) => t.id === 's'))
      .toMatchObject({ name: 'Плавание', repeat: { startDay: '2026-10-12' } });
  });
});

// ── spec 011: цели по датам ──────────────────────────────────────────────────

describe('планировщик: цели питания по датам (spec 011)', () => {
  const base = { kcal: { target: 2000, tolerance: 100 }, water: { target: 2000, tolerance: 300 } };
  const state = stateWith({
    goals: base,
    goalPeriods: [
      { id: 'week', startDay: '2026-10-20', endDay: '2026-10-27', goals: { kcal: { target: 2500, tolerance: 100 } } },
      { id: 'day', startDay: '2026-10-15', endDay: '2026-10-15', goals: { kcal: { target: 1500, tolerance: 100 } } },
      { id: 'inside', startDay: '2026-10-25', endDay: '2026-10-25', goals: { kcal: { target: 1200, tolerance: 100 } } },
      { id: 'long', startDay: '2026-11-01', endDay: '', goals: { kcal: { target: 2200, tolerance: 100 } } },
      { id: 'short', startDay: '2026-11-01', endDay: '2026-11-03', goals: { kcal: { target: 1800, tolerance: 100 } } },
    ],
  });

  it('SC-004: накрывающая запись — позже начатая, затем короче; иначе цели «с самого начала»', () => {
    expect(getGoalRecordForDay(state, '2026-10-14')?.id).toBe('');
    expect(getGoalRecordForDay(state, '2026-10-15')?.id).toBe('day');
    expect(getGoalRecordForDay(state, '2026-10-16')?.id).toBe('');
    expect(getGoalRecordForDay(state, '2026-10-22')?.id).toBe('week');
    expect(getGoalRecordForDay(state, '2026-10-25')?.id).toBe('inside');
    expect(getGoalRecordForDay(state, '2026-10-28')?.id).toBe('');
    expect(getGoalRecordForDay(state, '2026-11-02')?.id).toBe('short');
    expect(getGoalRecordForDay(state, '2026-11-10')?.id).toBe('long');
    expect(getGoalRecordForDay(stateWith({ goals: {} }), TODAY)).toBeUndefined();
    expect(validateGoalRecord({ startDay: '2026-11-05', endDay: '2026-11-01', goals: base })).toBe('endDay');
    expect(validateGoalRecord({ startDay: '2026-11-05', endDay: '', goals: {} })).toBe('empty');
    expect(validateGoalRecord({ startDay: '', endDay: '', goals: { fiber: { target: 10, tolerance: 20 } } }))
      .toBe('fiber');
  });

  it('статусы по воде и клетчатке; показатель без цели — только факт', () => {
    const food = stateWith({
      goals: { ...base, fiber: { target: 30, tolerance: 5 } },
      nutrition: {
        [TODAY]: {
          entries: [{ id: 'a', name: 'a', meal: 'lunch', kcal: 2000, fiber: 20 }],
          isComplete: true,
          fixedGoals: { ...base, fiber: { target: 30, tolerance: 5 } },
          waterMl: 1500,
        },
        '2026-10-07': {
          entries: [{ id: 'b', name: 'b', meal: 'lunch', kcal: 1000 }],
          isComplete: true,
          fixedGoals: { kcal: { target: 1000, tolerance: 100 } },
          waterMl: 2000,
        },
      },
    });
    expect(getNutrientTotal(food, TODAY, 'water')).toEqual({ value: 1500, missing: 0, count: 1 });
    expect(getNutrientStatus(food, TODAY, 'water')).toBe('below');
    expect(getNutrientStatus(food, TODAY, 'fiber')).toBe('below');
    expect(getNutrientStatus(food, TODAY, 'protein')).toBe('nogoal');
    expect(getNutrientStatus(food, '2026-10-07', 'water')).toBe('nogoal');
    expect(getNutrientStatus(food, '2026-10-07', 'fiber')).toBe('nogoal');
    expect(getNutrientStatus(food, '2026-10-06', 'water')).toBe('none');
    const stat = getNutrientStatistics(food, ['2026-10-07', TODAY], 'water', TODAY);
    expect(stat).toMatchObject({ recorded: ['2026-10-07', TODAY], withGoal: [TODAY], inGoal: 0, average: 1750 });
  });
});

describe('планировщик: статистика времени и хранение', () => {
  it('время по спискам и событиям; скрытая группа не входит в сумму', () => {
    const state = stateWith({
      projects: ['', 'Учёба'],
      events: [{ id: '5', name: 'e', start: '10:00', end: '11:00', day: TODAY }],
      tasks: [
        task({ id: '1', day: TODAY, minutes: 30, project: 'Учёба' }),
        task({ id: '2', day: TODAY }),
        task({ id: '3', minutes: 500 }),
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
      tasks: [{ id: '7', name: 'x', status: 'nonsense', project: 'Дом', day: 'вчера', minutes: 2 }],
      events: [{ id: '9', name: 'e', start: '25:00', end: '26:00' }],
      projects: ['Работа'],
    });
    expect(restored.tasks[0]).toMatchObject({ id: '7', status: 'queue', project: 'Дом', description: '', steps: [] });
    expect(restored.tasks[0].day).toBeUndefined();
    expect(restored.tasks[0].minutes).toBeUndefined();
    expect(restored.events).toEqual([]);
    expect(restored.projects).toEqual(['', 'Работа', 'Дом']);
    expect(restored.lists.map((list) => list.name)).toEqual(['Работа', 'Дом']);
  });
});
