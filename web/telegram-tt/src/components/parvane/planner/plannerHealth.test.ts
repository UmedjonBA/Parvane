import { describe, expect, it } from 'vitest';

import type { QuickContext } from './plannerQuick';

import {
  applyQuickDraft, clockDifference, dailyRecordId, formatPace, getActiveMinutes, getBedOffset, getClockGoal,
  getClockStat, getDailyRecord, getDailySeries, getDayBudget, getLastDays, getLatestRecord, getLimitTotal,
  getSleepAxis, getSleepRecords, getSleepRoutine, getSleepRoutineLevel, getSleepSpan,
  getWorkouts, isShortSleep, parseClock, SLEEP_ROUTINE_DAYS, SLEEP_ROUTINE_DRIFTING_SPREAD,
  SLEEP_ROUTINE_MIN_NIGHTS, SLEEP_ROUTINE_STABLE_SPREAD, wrapClock,
} from './plannerHealth';
import { createEmptyPlannerState } from './plannerModel';
import { parseQuickInput } from './plannerQuick';

const TODAY = '2026-10-08';
const CTX: QuickContext = {
  today: TODAY, nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};

function stateAfter(lines: string[]) {
  const state = createEmptyPlannerState();
  lines.forEach((line) => {
    expect(applyQuickDraft(state, parseQuickInput(line, CTX), TODAY), line).toBeDefined();
  });
  return state;
}

describe('здоровье: черновик ввода → состояние', () => {
  it('задача и событие', () => {
    const state = stateAfter(['купить кабель', 'созвон завтра 16:00 45 мин', 'урок вт 15:00 каждую неделю']);
    expect(state.tasks.map(({ name }) => name)).toEqual(['купить кабель']);
    expect(state.events[0]).toMatchObject({ name: 'созвон', day: '2026-10-09', start: '16:00', end: '16:45' });
    expect(state.events[1].day).toBeUndefined();
    expect(state.events[1].repeat?.weekdays).toEqual([2]);
  });

  it('описание из строки уходит в событие и в задачу', () => {
    const state = stateAfter([
      'вт 15:00 пара по Английскому будет тест  лисининг', 'задача сдать отчёт до пт — приложить таблицу',
      'созвон завтра 16:00',
    ]);
    expect(state.events[0]).toMatchObject({
      name: 'пара по Английскому', description: 'будет тест лисининг', day: '2026-10-13', start: '15:00', end: '16:45',
    });
    expect(state.tasks[0]).toMatchObject({ name: 'сдать отчёт', description: 'приложить таблицу', due: '2026-10-09' });
    expect(state.events[1].description).toBeUndefined();
  });

  it('метки строки: список, место и «важное»', () => {
    const state = stateAfter([
      'купить молоко #Дом', 'купить хлеб #дом @Ашан ! — бородинский', 'пара вт 15:00 @301ГК — взять тетрадь',
      'созвон завтра 16:00 @Zoom', 'позвонить в банк #мой_банк',
    ]);
    // Список создаётся один раз; второе упоминание находит его без учёта регистра
    expect(state.lists.map(({ name }) => name)).toEqual(['Дом', 'мой банк']);
    expect(state.projects).toEqual(['', 'Дом', 'мой банк']);
    expect(state.tasks[0]).toMatchObject({ name: 'купить молоко', project: 'Дом', status: 'queue', description: '' });
    expect(state.tasks[1]).toMatchObject({
      name: 'купить хлеб', project: 'Дом', status: 'active', description: '@Ашан\nбородинский',
    });
    expect(state.tasks[2]).toMatchObject({ name: 'позвонить в банк', project: 'мой банк' });
    expect(state.events[0]).toMatchObject({ name: 'пара', description: '@301ГК\nвзять тетрадь' });
    expect(state.events[1]).toMatchObject({ name: 'созвон', description: '@Zoom' });
  });

  it('еда с сахаром и временем, вода складывается', () => {
    const state = stateAfter(['обед гречка 150г б30 ж10 у60 кл6 сахар 4 13:30 520 ккал', 'вода 500 мл', '2 стакана']);
    const day = state.nutrition[TODAY];
    expect(day.entries[0]).toMatchObject({
      name: 'гречка', meal: 'lunch', kcal: 520, protein: 30, fiber: 6, sugar: 4, grams: 150, time: '13:30',
    });
    expect(day.waterMl).toBe(1000);
    expect(getLimitTotal(state, TODAY, 'sugar')).toBe(4);
    expect(getLimitTotal(state, TODAY, 'salt')).toBe(0);
  });

  it('показатель — одна запись на день, новая заменяет прежнюю; сон дня — сумма снов', () => {
    const state = stateAfter(['вес 72,4', 'вес 72,1', 'сон 01:00-06:00', 'давление 120/80']);
    expect(state.health.filter(({ kind }) => kind === 'weight')).toHaveLength(1);
    expect(getDailyRecord(state, 'weight', TODAY)?.value).toBe(72.1);
    expect(getDailyRecord(state, 'sleep', TODAY)).toMatchObject({ time: '01:00', endTime: '06:00', value: 300 });
    expect(getDailyRecord(state, 'pressure', TODAY)).toMatchObject({ value: 120, value2: 80 });
    // Сон короче шести часов снижает бюджет дня на пятую часть
    expect(isShortSleep(state, TODAY)).toBe(true);
    expect(getDayBudget(state, TODAY)).toBe(480);
    expect(getDayBudget(state, '2026-10-09')).toBe(600);
  });

  it('тренировки копятся; активные минуты и темп', () => {
    const state = stateAfter(['бег 5 км 28 мин', 'зал присед 4x8x80, жим 3x10x60', 'йога вчера 40 мин']);
    const week = getLastDays(TODAY);
    expect(week).toHaveLength(7);
    expect(week[6]).toBe(TODAY);
    expect(getWorkouts(state, week).map(({ name }) => name)).toEqual(['бег', 'зал', 'йога']);
    expect(getActiveMinutes(state, week)).toBe(68);
    expect(getWorkouts(state, week)[1].exercises).toHaveLength(2);
    expect(formatPace(28, 5)).toBe('5:36');
    expect(formatPace(0, 5)).toBeUndefined();
  });

  it('цели и настройки текстом', () => {
    const state = stateAfter(['цель белок 140 вода 2,5л сон 8ч день с 8 до 22 шаги 9000 бюджет 8 ч']);
    expect(state.goals.protein).toEqual({ target: 140, tolerance: 20 });
    expect(state.goals.water).toEqual({ target: 2500, tolerance: 250 });
    expect(state.healthGoals).toMatchObject({ sleepMinutes: 480, steps: 9000, sugarMax: 50 });
    expect(state.settings).toMatchObject({ dayStart: 480, dayEnd: 1320 });
    expect(state.budget).toBe(480);
    expect(state.tasks).toHaveLength(0);
  });

  it('черновик с ошибкой не записывается; ряды значений и последняя запись', () => {
    const state = stateAfter(['шаги 9500']);
    expect(applyQuickDraft(state, parseQuickInput('самочувствие 9', CTX), TODAY)).toBeUndefined();
    expect(state.health).toHaveLength(1);
    expect(getDailySeries(state, 'steps', getLastDays(TODAY, 3))).toEqual([undefined, undefined, 9500]);
    expect(getLatestRecord(state, 'steps', '2026-10-20')?.value).toBe(9500);
    expect(getLatestRecord(state, 'steps', '2026-10-01')).toBeUndefined();
  });
});

// Ночь: «лёг-встал» либо одна длительность в минутах
type Night = [string, string] | number;

function stateWithSleep(nights: Record<string, Night>) {
  const state = createEmptyPlannerState();
  state.health = Object.entries(nights).map(([day, night]) => {
    const id = dailyRecordId('sleep', day);
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
  const days = getLastDays(TODAY, nights.length);
  return stateWithSleep(Object.fromEntries(nights.map((night, index) => [days[index], night])));
}

describe('здоровье: шкала графика режима', () => {
  it('сон через полночь начинается накануне, остальные — в свой день', () => {
    expect(getSleepSpan({ time: '23:15', endTime: '06:45' })).toEqual({ from: -45, to: 405 });
    expect(getSleepSpan({ time: '04:10', endTime: '09:20' })).toEqual({ from: 250, to: 560 });
    expect(getSleepSpan({ time: '14:00', endTime: '15:30' })).toEqual({ from: 840, to: 930 });
    expect(getSleepSpan({ time: '19:30', endTime: '20:40' })).toEqual({ from: 1170, to: 1240 });
    expect(getSleepSpan({ time: '07:00', endTime: '07:00' })).toBeUndefined();
    expect(getSleepSpan({ endTime: '07:00' })).toBeUndefined();
    expect(getBedOffset(23 * 60 + 30)).toBe(-30);
    expect(getBedOffset(60)).toBe(60);
  });

  it('границы оси — на целых шагах, подписи — каждый шаг', () => {
    // Ночь 23:15–06:45: от 22:00 до 08:00, подпись каждые два часа
    expect(getSleepAxis([-45, 405])).toMatchObject({ low: -120, high: 480, step: 120 });
    // Ночь и вечерний сон того же дня — длинная ось, шаг реже
    const axis = getSleepAxis([-45, 405, 1170, 1240]);
    expect(axis.step).toBe(180);
    expect(axis.low).toBe(-180);
    expect(axis.high).toBe(1440);
    expect(axis.ticks).toHaveLength(10);
    expect(getSleepAxis([])).toMatchObject({ low: -120, high: 480 });
  });
});

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
    expect(parseClock('07:05')).toBe(425);
    expect(parseClock('7:05')).toBe(425);
    expect(parseClock('25:00')).toBeUndefined();
    expect(parseClock('07:75')).toBeUndefined();
    expect(parseClock('утром')).toBeUndefined();
    expect(parseClock(undefined)).toBeUndefined();
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
    expect(routine.outliers[0].day).toBe(getLastDays(TODAY, 14)[9]);
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
    const record = (day: string, time: string, value: number) => ({
      id: dailyRecordId('sleep', day), day, kind: 'sleep', time, endTime: '07:00', value,
    });
    state.health.push(record('2026-10-01', '25:00', 400));
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
    state.health.push(record('2026-10-02', '23:30', 450));
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

  it('цель режима задаётся текстом и не трогает цель длительности', () => {
    const state = stateAfter(['цель сон 23:30-07:00']);
    expect(state.healthGoals).toMatchObject({ bedtime: 1410, wakeTime: 420, sleepMinutes: 480 });
    applyQuickDraft(state, parseQuickInput('цель сон 7 ч', CTX), TODAY);
    expect(state.healthGoals).toMatchObject({ bedtime: 1410, wakeTime: 420, sleepMinutes: 420 });
    // «24:00» — полночь
    applyQuickDraft(state, parseQuickInput('цель сон 24:00-08:00', CTX), TODAY);
    expect(state.healthGoals).toMatchObject({ bedtime: 0, wakeTime: 480, sleepMinutes: 420 });
  });

  it('сдвиг выходных: середина сна в выходные против будней', () => {
    // 2026-10-08 — четверг; ночи на субботу и воскресенье — 26, 27 сентября и 3, 4 октября
    const nights: Record<string, Night> = {};
    getLastDays(TODAY, 14).forEach((day) => {
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

  it('строка блока «Сон» пишет сон в день экрана — и временем, и одной длительностью', () => {
    const state = createEmptyPlannerState();
    const save = (day: string, line: string, lang: 'ru' | 'en') => {
      const draft = parseQuickInput(line, {
        ...CTX, today: day, nowMinutes: 0, kind: 'sleep', lang,
      });
      expect(draft, line).toMatchObject({ kind: 'sleep', day });
      expect(draft.error, line).toBeUndefined();
      applyQuickDraft(state, draft, day);
    };
    save('2026-10-05', '23:40-07:30', 'en');
    save('2026-10-06', '7.5 h', 'en');
    save('2026-10-07', '7,5 ч', 'ru');
    save('2026-10-04', 'сон 23:50-07:20', 'ru');
    expect(getDailyRecord(state, 'sleep', '2026-10-05')).toMatchObject({ time: '23:40', endTime: '07:30', value: 470 });
    expect(getDailyRecord(state, 'sleep', '2026-10-06')).toMatchObject({ time: undefined, value: 450 });
    expect(getDailyRecord(state, 'sleep', '2026-10-07')).toMatchObject({ time: undefined, value: 450 });
    expect(getDailyRecord(state, 'sleep', '2026-10-04')).toMatchObject({ time: '23:50', endTime: '07:20' });
    expect(getDailyRecord(state, 'sleep', TODAY)).toBeUndefined();
    expect(getSleepRoutine(state, TODAY)).toMatchObject({ timedCount: 2, untimedCount: 2 });
    // Цель режима строкой блока целей
    const goal = parseQuickInput('sleep 23:30-07:00', { ...CTX, kind: 'goal', lang: 'en' });
    expect(goal.goalChanges?.health).toEqual({ bedtime: 1410, wakeTime: 420 });
  });

  // Те же ночи вписывает сценарий scripts/e2e_web_health.mjs: уровни и числа экрана закреплены здесь
  it('ночи сценария: стабильный → сбит → ночь без времени → «плавает»', () => {
    const days = getLastDays(TODAY, 7);
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
    state.health.push(...stateWithSleep({ [days[5]]: ['02:40', '10:30'] }).health);
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

describe('здоровье: несколько снов за день и «не спал» (16 окт 2026)', () => {
  it('ночь и дневной сон: сумма за день, время — по ночи; повтор не добавляется', () => {
    const state = stateAfter(['сон 23:00-07:00', 'спал с 14 до 15:30', 'спал с 14 до 15:30']);
    expect(getSleepRecords(state, TODAY)).toHaveLength(2);
    expect(getDailyRecord(state, 'sleep', TODAY)).toMatchObject({ value: 570, time: '23:00', endTime: '07:00' });
  });

  it('«не спал» — 0 ч; настоящий сон его убирает; при сне «не спал» не добавляется', () => {
    const state = stateAfter(['не спал']);
    expect(getDailyRecord(state, 'sleep', TODAY)?.value).toBe(0);
    applyQuickDraft(state, parseQuickInput('спал с 14 до 15', CTX), TODAY);
    expect(getSleepRecords(state, TODAY).map(({ value }) => value)).toEqual([60]);
    applyQuickDraft(state, parseQuickInput('не спал', CTX), TODAY);
    expect(getSleepRecords(state, TODAY).map(({ value }) => value)).toEqual([60]);
  });

  it('правка меняет только свой сон', () => {
    const state = stateAfter(['сон 23:00-07:00', 'спал с 14 до 15']);
    const nap = getSleepRecords(state, TODAY)[1];
    applyQuickDraft(state, parseQuickInput('сон 13:00-14:00', { ...CTX, kind: 'sleep' }), TODAY, nap.id);
    expect(getSleepRecords(state, TODAY).map(({ id, time }) => [id, time])).toEqual([
      [dailyRecordId('sleep', TODAY), '23:00'], [nap.id, '13:00'],
    ]);
  });
});

describe('здоровье: ноль часов сна', () => {
  it.each(['0', '0ч', '0 ч', 'не спал'])('«%s» в поле сна — 0 ч', (line) => {
    const draft = parseQuickInput(line, { ...CTX, kind: 'sleep' });
    expect(draft).toMatchObject({ kind: 'sleep', minutes: 0 });
    expect(draft.error).toBeUndefined();
  });

  it('«сон 0 ч» в общем вводе — 0 ч', () => {
    expect(parseQuickInput('сон 0 ч', CTX)).toMatchObject({ kind: 'sleep', minutes: 0 });
  });
});
