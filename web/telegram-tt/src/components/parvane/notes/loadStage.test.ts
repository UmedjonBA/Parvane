import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { LoadStage } from './loadStage';

import { NO_ANSWER_AFTER_MS, SLOW_AFTER_MS, watchLoadStage } from './loadStage';

describe('watchLoadStage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows «Loading…» after 3 s and «No response» with retry after 10 s', () => {
    const stages: LoadStage[] = [];
    watchLoadStage((stage) => stages.push(stage), true);

    vi.advanceTimersByTime(SLOW_AFTER_MS - 1);
    expect(stages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stages).toEqual(['slow']);
    vi.advanceTimersByTime(NO_ANSWER_AFTER_MS - SLOW_AFTER_MS - 1);
    expect(stages).toEqual(['slow']);
    vi.advanceTimersByTime(1);
    expect(stages).toEqual(['slow', 'noAnswer']);
    expect(NO_ANSWER_AFTER_MS).toBe(10000);
  });

  it('never gives up without a way to retry', () => {
    const stages: LoadStage[] = [];
    watchLoadStage((stage) => stages.push(stage));

    vi.advanceTimersByTime(NO_ANSWER_AFTER_MS * 3);
    expect(stages).toEqual(['slow']);
  });

  it('stops counting once loading is over', () => {
    const stages: LoadStage[] = [];
    const stop = watchLoadStage((stage) => stages.push(stage), true);

    vi.advanceTimersByTime(SLOW_AFTER_MS);
    stop();
    vi.advanceTimersByTime(NO_ANSWER_AFTER_MS);
    expect(stages).toEqual(['slow']);
  });
});
