import { describe, expect, it } from 'vitest';

import type { HealthDays } from '../health/healthTypes';

import { getDailyRecord, getDayBudget, isShortSleep } from './plannerHealth';
import { withHealthDays } from './plannerHealthDays';
import { createEmptyPlannerState, getGoalsForDay, getNutrientTotal } from './plannerModel';

const DAYS: HealthDays = {
  goals: {
    kcal: 2200, sleep_bed: 1410, sleep_wake: 420, steps: 10000,
  },
  days: [
    {
      day: '2026-11-14',
      closed: true,
      sleeps: [{ id: 'dur', minutes: 300 }],
      foods: [],
      workouts: [{
        id: 'run', minute: 540, minutes: 35, name: '', tag: 'run', parts: { km: 6.2 },
      }],
    },
    {
      day: '2026-11-15',
      closed: false,
      sleeps: [
        {
          id: 'night', minutes: 450, bedMin: 1410, wakeMin: 420,
        },
        {
          id: 'nap', minutes: 60, bedMin: 840, wakeMin: 900,
        },
      ],
      foods: [
        {
          id: 'f1', minute: 495, name: 'овсянка', tag: 'breakfast', kcal: 430, parts: { protein: 22 },
        },
        {
          id: 'f2', minute: 795, name: 'суп', tag: 'brunch', kcal: 300, parts: {},
        },
      ],
      workouts: [],
    },
  ],
};

describe('withHealthDays', () => {
  const own = createEmptyPlannerState();
  own.health = [{
    id: 'old', day: '2026-11-15', kind: 'sleep', value: 100,
  }];
  const state = withHealthDays(own, DAYS);

  it('feeds sleep of the day: the sum with the clock of the longest one', () => {
    const sleep = getDailyRecord(state, 'sleep', '2026-11-15')!;
    expect(sleep.value).toBe(510);
    expect(sleep.time).toBe('23:30');
    expect(sleep.endTime).toBe('07:00');
    expect(getDailyRecord(state, 'sleep', '2026-11-14')!.time).toBeUndefined();
    expect(isShortSleep(state, '2026-11-14')).toBe(true);
    expect(getDayBudget(state, '2026-11-14')).toBeLessThan(getDayBudget(state, '2026-11-15'));
  });

  it('feeds meals with time, totals, goals and the closed day', () => {
    expect(getNutrientTotal(state, '2026-11-15', 'kcal').value).toBe(730);
    expect(state.nutrition['2026-11-15'].entries.map((entry) => [entry.meal, entry.time])).toEqual([
      ['breakfast', '08:15'], ['other', '13:15'],
    ]);
    expect(state.nutrition['2026-11-14'].isComplete).toBe(true);
    expect(getGoalsForDay(state, '2026-11-15').kcal?.target).toBe(2200);
    expect(state.healthGoals.sleepMinutes).toBe(450);
  });

  it('keeps the rest of the plan and drops its own health records', () => {
    expect(state.tasks).toBe(own.tasks);
    expect(state.health.some((record) => record.id === 'old')).toBe(false);
    expect(state.health.find((record) => record.kind === 'workout')).toMatchObject({ value: 35, value2: 6.2 });
    expect(withHealthDays(own, undefined).health).toEqual([]);
  });
});
