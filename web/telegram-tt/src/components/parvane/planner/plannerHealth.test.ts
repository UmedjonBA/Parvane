import { describe, expect, it } from 'vitest';

import type { QuickContext } from './plannerQuick';

import {
  applyQuickDraft, formatPace, getActiveMinutes, getDailyRecord, getDailySeries, getDayBudget, getLastDays,
  getLatestRecord, getLimitTotal, getWorkouts, isShortSleep,
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

  it('показатель и сон — одна запись на день, новая заменяет прежнюю', () => {
    const state = stateAfter(['вес 72,4', 'вес 72,1', 'сон 23:40-07:30', 'сон 01:00-06:00', 'давление 120/80']);
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
