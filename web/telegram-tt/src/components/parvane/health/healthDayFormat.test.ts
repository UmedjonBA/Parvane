import { describe, expect, it } from 'vitest';

import {
  barShares, EMPTY_EXTRA_FORM, extraDraftOf, extraFormOf, formatPace, goalShare, hasExtraFields, mealTitleKey,
  workoutTitleKey,
} from './healthDayFormat';

describe('healthDayFormat', () => {
  it('names meals and workout types, unknown ones fall back', () => {
    expect(mealTitleKey('lunch')).toBe('HealthMealLunch');
    expect(mealTitleKey('brunch')).toBe('HealthMealOther');
    expect(workoutTitleKey('run')).toBe('HealthWorkoutRun');
    expect(workoutTitleKey('')).toBe('HealthWorkoutOther');
  });

  it('formats pace and shares', () => {
    expect(formatPace(339)).toBe('5:39');
    expect(formatPace(300)).toBe('5:00');
    expect(goalShare(1420, 2200)).toBeCloseTo(0.645, 2);
    expect(goalShare(3000, 2200)).toBe(1);
    expect(goalShare(100, undefined)).toBe(0);
    expect(barShares([5000, undefined, 10000])).toEqual([0.5, 0, 1]);
    expect(barShares([5000], 10000)).toEqual([0.5]);
    expect(barShares([undefined])).toEqual([0]);
  });

  it('turns a food entry into form fields and back, keeping numbers the form does not show', () => {
    const entry = { name: 'творог', tag: 'snack', parts: { protein: 18, grams: 200 } };
    const form = extraFormOf(entry);
    expect(form).toEqual({
      ...EMPTY_EXTRA_FORM, name: 'творог', tag: 'snack', protein: '18',
    });
    expect(extraDraftOf('food', { ...form, fat: '5,5', protein: '' }, entry.parts)).toEqual({
      name: 'творог', tag: 'snack', parts: { fat: 5.5, grams: 200 },
    });
    expect(extraDraftOf('food', { ...form, carbs: 'много' }, entry.parts)).toBeUndefined();
    expect(extraDraftOf('food', { ...form, carbs: '-1' }, entry.parts)).toBeUndefined();
  });

  it('workout fields are distance and exercises; other kinds have none', () => {
    expect(extraDraftOf('workout', { ...EMPTY_EXTRA_FORM, tag: 'run', km: '6.2' })).toEqual({
      name: '', tag: 'run', parts: { km: 6.2 },
    });
    expect(hasExtraFields('workout')).toBe(true);
    expect(hasExtraFields('weight')).toBe(false);
    expect(extraDraftOf('weight', EMPTY_EXTRA_FORM)).toEqual({});
  });
});
