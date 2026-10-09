import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('../../../api/gramjs', () => ({ callApi: vi.fn(() => Promise.resolve(undefined)) }));

const { getPlannerNotice, showPlannerNotice } = await import('./plannerStore');

describe('Уведомление планировщика', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('скрывается само через 3 секунды', () => {
    showPlannerNotice('Saved');
    expect(getPlannerNotice()?.text).toBe('Saved');
    vi.advanceTimersByTime(2900);
    expect(getPlannerNotice()?.text).toBe('Saved');
    vi.advanceTimersByTime(200);
    expect(getPlannerNotice()).toBeUndefined();
  });

  it('новое уведомление начинает отсчёт заново', () => {
    showPlannerNotice('First');
    vi.advanceTimersByTime(2000);
    showPlannerNotice('Second');
    vi.advanceTimersByTime(2000);
    expect(getPlannerNotice()?.text).toBe('Second');
    vi.advanceTimersByTime(1100);
    expect(getPlannerNotice()).toBeUndefined();
  });
});
