import { describe, expect, it } from 'vitest';

import type { PlannerHealthRecord } from './plannerModel';

import {
  clockDifference, getClockGoal, getClockStat, getDailyRecord, getDayBudget, getSleepRoutine, getSleepRoutineLevel,
  getWorkouts, isShortSleep, SLEEP_ROUTINE_DAYS, SLEEP_ROUTINE_DRIFTING_SPREAD, SLEEP_ROUTINE_MIN_NIGHTS,
  SLEEP_ROUTINE_STABLE_SPREAD, wrapClock,
} from './plannerHealth';
import { addDays, createEmptyPlannerState } from './plannerModel';

const TODAY = '2026-10-08';

// Дни, заканчивающиеся этим днём
function lastDays(day: string, count: number) {
  return Array.from({ length: count }, (_, index) => addDays(day, index - count + 1));
}

// Ночь: «лёг-встал» либо одна длительность в минутах
type Night = [string, string] | number;

function stateWithSleep(nights: Record<string, Night>) {
  const state = createEmptyPlannerState();
  state.health = Object.entries(nights).map(([day, night]): PlannerHealthRecord => {
    const id = `sleep-${day}`;
    if (typeof night === 'number') return { id, day, kind: 'sleep', value: night };
    const [time, endTime] = night;
    const [bed, wake] = [time, endTime].map((clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)));
    return {
      id, day, kind: 'sleep', time, endTime, value: (wake - bed + 1440) % 1440,
    };
  });
  return state;
}

// Ночи подряд, последняя — на TODAY
function lastNights(nights: Night[]) {
  const days = lastDays(TODAY, nights.length);
  return stateWithSleep(Object.fromEntries(nights.map((night, index) => [days[index], night])));
}

describe('здоровье: режим сна', () => {
  it('время суток — круг: среднее через полночь, разница и приведение', () => {
    expect(getClockStat([23 * 60 + 40, 20])).toMatchObject({ mean: 0, spread: 20 });
    expect(getClockStat([23 * 60 + 50, 23 * 60 + 30])?.mean).toBe(23 * 60 + 40);
    expect(clockDifference(20, 23 * 60 + 40)).toBe(40);
    expect(clockDifference(23 * 60 + 40, 20)).toBe(-40);
    expect(clockDifference(600, 600)).toBe(0);
    expect(wrapClock(1450)).toBe(10);
    expect(wrapClock(-20)).toBe(1420);
    expect(getClockStat([])).toBeUndefined();
    // Противоположные времена: направления нет, разброс наибольший
    expect(getClockStat([0, 720])).toMatchObject({ mean: 0, spread: 720 });
  });

  it('пороги уровня', () => {
    expect(getSleepRoutineLevel(undefined)).toBe('none');
    expect(getSleepRoutineLevel(0)).toBe('stable');
    expect(getSleepRoutineLevel(SLEEP_ROUTINE_STABLE_SPREAD)).toBe('stable');
    expect(getSleepRoutineLevel(SLEEP_ROUTINE_STABLE_SPREAD + 1)).toBe('drifting');
    expect(getSleepRoutineLevel(SLEEP_ROUTINE_DRIFTING_SPREAD)).toBe('drifting');
    expect(getSleepRoutineLevel(SLEEP_ROUTINE_DRIFTING_SPREAD + 1)).toBe('broken');
    expect([SLEEP_ROUTINE_DAYS, SLEEP_ROUTINE_MIN_NIGHTS]).toEqual([14, 4]);
  });

  it('отход ко сну вокруг полуночи: среднее 00:00, отклонения со знаком', () => {
    const routine = getSleepRoutine(lastNights([
      ['23:40', '07:00'], ['00:20', '07:00'], ['23:50', '07:00'], ['00:10', '07:00'],
    ]), TODAY);
    expect(routine).toMatchObject({ level: 'stable', timedCount: 4, untimedCount: 0, spread: 16 });
    expect(routine).toMatchObject({ bed: { mean: 0, spread: 16 }, wake: { mean: 420, spread: 0 } });
    expect(routine.nights.map(({ bedDeviation }) => bedDeviation)).toEqual([-20, 20, -10, 10]);
    expect(routine.nights.map(({ wakeDeviation }) => wakeDeviation)).toEqual([0, 0, 0, 0]);
    // Окно — между десятой и девяностой долей ночей: 23:43…00:17
    expect(routine.bed).toMatchObject({ from: 23 * 60 + 43, to: 17 });
    // Середина сна: 03:20, 03:40, 03:25, 03:35
    expect(routine.nights.map(({ midpoint }) => midpoint)).toEqual([200, 220, 205, 215]);
    expect(routine.midpoint).toMatchObject({ mean: 210, spread: 8 });
    expect(routine.center).toBe(210);
    expect(routine.outliers).toEqual([]);
  });

  it('одинаковые ночи: разброс ноль, окно стянуто в точку', () => {
    const routine = getSleepRoutine(lastNights(new Array<Night>(14).fill(['23:30', '07:00'])), TODAY);
    expect(routine).toMatchObject({
      level: 'stable',
      timedCount: 14,
      spread: 0,
      bed: {
        mean: 1410, spread: 0, from: 1410, to: 1410,
      },
      wake: {
        mean: 420, spread: 0, from: 420, to: 420,
      },
      midpoint: { mean: 195, spread: 0 },
    });
    expect(routine.nights.every(({ deviation }) => deviation === 0)).toBe(true);
    expect(routine.outliers).toEqual([]);
  });

  it('дневной сон: ложится утром', () => {
    const routine = getSleepRoutine(lastNights([
      ['08:00', '16:00'], ['08:20', '16:10'], ['07:40', '15:50'], ['08:00', '16:00'],
    ]), TODAY);
    expect(routine).toMatchObject({
      level: 'stable', bed: { mean: 480, spread: 14 }, wake: { mean: 960, spread: 7 }, midpoint: { mean: 720 },
    });
  });

  it('уровень — по худшему из двух разбросов', () => {
    // Ложится одинаково, встаёт то в 6, то в 8: разброс подъёма 60 мин
    const drifting = getSleepRoutine(lastNights([
      ['23:00', '06:00'], ['23:00', '08:00'], ['23:00', '06:00'], ['23:00', '08:00'],
    ]), TODAY);
    expect(drifting).toMatchObject({
      level: 'drifting', spread: 60, bed: { spread: 0 }, wake: { mean: 420, spread: 60 },
    });
    // То в десять вечера, то в два ночи
    const broken = getSleepRoutine(lastNights([
      ['22:00', '07:00'], ['02:00', '07:00'], ['22:00', '07:00'], ['02:00', '07:00'],
    ]), TODAY);
    expect(broken.level).toBe('broken');
    expect(broken.bed?.mean).toBe(0);
    expect(broken.spread).toBeGreaterThan(115);
    expect(broken.spread).toBeLessThan(130);
    // Все четыре ночи отклоняются на два часа; при равенстве новая — первой, называются три
    expect(broken.outliers.map(({ day }) => day)).toEqual(['2026-10-08', '2026-10-07', '2026-10-06']);
    expect(broken.outliers[0]).toMatchObject({ bedDeviation: 120, wakeDeviation: 0, deviation: 120 });
  });

  it('одна выбившаяся ночь из четырнадцати: режим «плавает», ночь названа', () => {
    const nights = new Array<Night>(14).fill(['23:30', '07:00']);
    nights[9] = ['02:30', '10:00'];
    const routine = getSleepRoutine(lastNights(nights), TODAY);
    expect(routine.level).toBe('drifting');
    expect(routine.spread).toBeGreaterThan(40);
    expect(routine.spread).toBeLessThan(55);
    expect(routine.outliers).toHaveLength(1);
    expect(routine.outliers[0].day).toBe(lastDays(TODAY, 14)[9]);
    expect(routine.outliers[0].deviation).toBeGreaterThan(160);
    // Остальные ночи сдвинуты от среднего меньше чем на четверть часа
    expect(routine.nights.filter(({ deviation }) => deviation! < 15)).toHaveLength(13);
    // Окно выброс не захватывает
    expect(clockDifference(routine.bed!.to, 23 * 60 + 30)).toBeLessThan(15);
  });

  it('пропущенные ночи и ночи вне окна', () => {
    const state = stateWithSleep({
      // Раньше двух недель — не в счёт
      '2026-09-20': ['04:00', '12:00'],
      '2026-09-25': ['23:30', '07:00'],
      '2026-09-29': ['23:50', '07:10'],
      '2026-10-03': ['23:40', '07:20'],
      '2026-10-08': ['23:20', '06:50'],
    });
    const routine = getSleepRoutine(state, TODAY);
    expect(routine.days).toHaveLength(14);
    expect(routine.days[0]).toBe('2026-09-25');
    expect(routine.nights.map(({ day }) => day)).toEqual(['2026-09-25', '2026-09-29', '2026-10-03', '2026-10-08']);
    expect(routine).toMatchObject({ level: 'stable', timedCount: 4, bed: { mean: 23 * 60 + 35, spread: 11 } });
    // Окно короче — ночей не хватает. день раньше — последней ночи ещё нет
    expect(getSleepRoutine(state, TODAY, 7)).toMatchObject({ level: 'none', timedCount: 2 });
    expect(getSleepRoutine(state, '2026-10-07')).toMatchObject({ level: 'none', timedCount: 3 });
    expect(getSleepRoutine(state, '2026-10-07', 18)).toMatchObject({ level: 'broken', timedCount: 4 });
  });

  it('ночей со временем меньше четырёх — «мало данных»; длительность без времени считается отдельно', () => {
    const state = lastNights([['23:30', '07:00'], 450, ['23:40', '07:10'], 420, ['23:20', '06:50']]);
    // Негодное время в записи — тоже «без времени»
    const record = (day: string, time: string, value: number): PlannerHealthRecord => ({
      id: `sleep-${day}`, day, kind: 'sleep', time, endTime: '07:00', value,
    });
    state.health = [...state.health, record('2026-10-01', '25:00', 400)];
    const routine = getSleepRoutine(state, TODAY);
    expect(routine).toMatchObject({
      level: 'none', timedCount: 3, untimedCount: 3, outliers: [], center: 195,
    });
    expect(routine.bed).toBeUndefined();
    expect(routine.wake).toBeUndefined();
    expect(routine.midpoint).toBeUndefined();
    expect(routine.spread).toBeUndefined();
    expect(routine.nights).toHaveLength(6);
    const untimed = routine.nights.filter(({ bed }) => bed === undefined);
    expect(untimed.map(({ minutes }) => minutes)).toEqual([400, 450, 420]);
    expect(routine.nights.every(({ deviation }) => deviation === undefined)).toBe(true);
    // Четвёртая ночь со временем — режим считается, ночи без времени в него не входят
    state.health = [...state.health, record('2026-10-02', '23:30', 450)];
    expect(getSleepRoutine(state, TODAY)).toMatchObject({ level: 'stable', timedCount: 4, untimedCount: 3 });
    expect(getSleepRoutine(createEmptyPlannerState(), TODAY)).toMatchObject({
      level: 'none', timedCount: 0, untimedCount: 0, nights: [], center: undefined,
    });
  });

  it('отклонение от цели режима, в том числе через полночь', () => {
    const state = lastNights([['00:20', '07:30'], ['00:20', '07:30'], ['00:20', '07:30'], ['00:20', '07:30']]);
    expect(getSleepRoutine(state, TODAY)).toMatchObject({ bedGoalDeviation: undefined, wakeGoalDeviation: undefined });
    state.healthGoals = { ...state.healthGoals, bedtime: 23 * 60 + 30, wakeTime: 7 * 60 };
    expect(getSleepRoutine(state, TODAY)).toMatchObject({ bedGoalDeviation: 50, wakeGoalDeviation: 30 });
    state.healthGoals = { ...state.healthGoals, bedtime: 60, wakeTime: 8 * 60 };
    expect(getSleepRoutine(state, TODAY)).toMatchObject({ bedGoalDeviation: -40, wakeGoalDeviation: -30 });
    // Цель «в полночь» — ноль минут — тоже цель
    state.healthGoals = { ...state.healthGoals, bedtime: 0 };
    expect(getSleepRoutine(state, TODAY).bedGoalDeviation).toBe(20);
    // Только одна из двух целей и негодное значение из сохранённого JSON
    state.healthGoals = { ...state.healthGoals, bedtime: 'поздно' as unknown as number, wakeTime: 7 * 60 + 30 };
    expect(getSleepRoutine(state, TODAY)).toMatchObject({ bedGoalDeviation: undefined, wakeGoalDeviation: 0 });
    expect([getClockGoal(0), getClockGoal(1439), getClockGoal(1440), getClockGoal(-5), getClockGoal(undefined)])
      .toEqual([0, 1439, undefined, undefined, undefined]);
  });

  it('сдвиг выходных: середина сна в выходные против будней', () => {
    // 2026-10-08 — четверг; ночи на субботу и воскресенье — 26, 27 сентября и 3, 4 октября
    const nights: Record<string, Night> = {};
    lastDays(TODAY, 14).forEach((day) => {
      nights[day] = ['2026-09-26', '2026-09-27', '2026-10-03', '2026-10-04'].includes(day)
        ? ['01:00', '10:00'] : ['23:00', '07:00'];
    });
    const routine = getSleepRoutine(stateWithSleep(nights), TODAY);
    // 05:30 против 03:00
    expect(routine.socialJetlag).toBe(150);
    expect(routine.level).toBe('broken');
    // Одной выходной ночи мало
    delete nights['2026-09-26'];
    delete nights['2026-09-27'];
    delete nights['2026-10-03'];
    expect(getSleepRoutine(stateWithSleep(nights), TODAY).socialJetlag).toBeUndefined();
    // Одних будней — тоже
    delete nights['2026-10-04'];
    expect(getSleepRoutine(stateWithSleep(nights), TODAY)).toMatchObject({ socialJetlag: undefined, level: 'stable' });
  });

  it('ночи сценария: стабильный → сбит → ночь без времени → «плавает»', () => {
    const days = lastDays(TODAY, 7);
    const steady: Night[] = [
      ['23:40', '07:30'], ['23:50', '07:20'], ['23:30', '07:30'], ['23:45', '07:40'], ['23:35', '07:25'],
    ];
    const nights: Record<string, Night> = { [TODAY]: ['01:00', '06:00'] };
    expect(getSleepRoutine(stateWithSleep(nights), TODAY)).toMatchObject({ level: 'none', timedCount: 1 });
    steady.forEach((night, index) => {
      nights[days[index]] = night;
    });
    const state = stateWithSleep(nights);
    state.healthGoals = { ...state.healthGoals, bedtime: 23 * 60 + 30, wakeTime: 7 * 60 };
    // Окно кончается днём экрана: сегодняшняя ночь в него не входит
    expect(getSleepRoutine(state, days[4])).toMatchObject({
      level: 'stable',
      timedCount: 5,
      bed: { mean: 23 * 60 + 40, spread: 7 },
      wake: { mean: 7 * 60 + 29, spread: 7 },
      outliers: [],
      bedGoalDeviation: 10,
      wakeGoalDeviation: 29,
    });
    state.health = [...state.health, ...stateWithSleep({ [days[5]]: ['02:40', '10:30'] }).health];
    const broken = getSleepRoutine(state, days[5]);
    expect(broken).toMatchObject({ level: 'broken', timedCount: 6 });
    expect(broken.outliers[0].day).toBe(days[5]);
    state.health = [
      ...state.health.filter(({ day }) => day !== days[5]), ...stateWithSleep({ [days[5]]: 450 }).health,
    ];
    expect(getSleepRoutine(state, days[5])).toMatchObject({ level: 'stable', timedCount: 5, untimedCount: 1 });
    const drifting = getSleepRoutine(state, TODAY);
    expect(drifting).toMatchObject({ level: 'drifting', timedCount: 6, untimedCount: 1 });
    expect(drifting.spread).toBeGreaterThan(SLEEP_ROUTINE_STABLE_SPREAD + 2);
  });

  it('режим не меняет бюджет дня: его снижает только короткий сон', () => {
    const state = lastNights([['22:00', '07:00'], ['02:00', '09:00'], ['22:00', '07:00'], ['02:00', '09:00']]);
    expect(getSleepRoutine(state, TODAY).level).toBe('broken');
    expect(getDayBudget(state, TODAY)).toBe(state.budget);
  });
});

describe('здоровье: сон и тренировки дня', () => {
  it('несколько снов за день: сумма, время — самого долгого; короткий сон снижает бюджет', () => {
    const state = createEmptyPlannerState();
    state.health = [
      {
        id: 's1', day: TODAY, kind: 'sleep', time: '01:00', endTime: '05:00', value: 240,
      },
      {
        id: 's2', day: TODAY, kind: 'sleep', time: '14:00', endTime: '15:00', value: 60,
      },
    ];
    expect(getDailyRecord(state, 'sleep', TODAY)).toMatchObject({ value: 300, time: '01:00', endTime: '05:00' });
    // Сон короче шести часов снижает бюджет дня на пятую часть
    expect(isShortSleep(state, TODAY)).toBe(true);
    expect(getDayBudget(state, TODAY)).toBe(480);
    expect(getDayBudget(state, '2026-10-09')).toBe(600);
  });

  it('тренировки дней: новые первыми, в дне — поздние первыми', () => {
    const state = createEmptyPlannerState();
    state.health = [
      {
        id: 'w1', day: '2026-10-07', kind: 'workout', time: '08:00', value: 40, name: 'йога',
      },
      {
        id: 'w2', day: TODAY, kind: 'workout', time: '07:00', value: 28, value2: 5, name: 'бег',
      },
      {
        id: 'w3', day: TODAY, kind: 'workout', time: '19:00', value: 60, name: 'зал',
      },
    ];
    expect(getWorkouts(state, lastDays(TODAY, 7)).map(({ name }) => name)).toEqual(['зал', 'бег', 'йога']);
    expect(getWorkouts(state, [TODAY])).toHaveLength(2);
  });
});
