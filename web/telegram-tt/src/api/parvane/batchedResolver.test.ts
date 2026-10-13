import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createBatchedResolver } from './batchedResolver';

describe('batched resolver (perf A3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges calls inside the collection window into one request', async () => {
    const resolve = vi.fn(() => Promise.resolve());
    const resolver = createBatchedResolver({
      delayMs: 200, ttlMs: 60_000, chunk: 100, resolve,
    });
    const first = resolver.request(['a@x', 'b@x']);
    const second = resolver.request(['b@x', 'c@x']);
    expect(resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toEqual(['a@x', 'b@x', 'c@x']);
  });

  it('does not re-request keys until the TTL passes, unless forced', async () => {
    const resolve = vi.fn(() => Promise.resolve());
    const resolver = createBatchedResolver({
      delayMs: 10, ttlMs: 1_000, chunk: 100, resolve,
    });
    const first = resolver.request(['a@x']);
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolver.isFresh('a@x')).toBe(true);

    void resolver.request(['a@x']);
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenCalledTimes(1);

    void resolver.request(['a@x'], true);
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    void resolver.request(['a@x']);
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('splits a long key list into chunks', async () => {
    const resolve = vi.fn(() => Promise.resolve());
    const resolver = createBatchedResolver({
      delayMs: 1, ttlMs: 1_000, chunk: 3, resolve,
    });
    void resolver.request(['1', '2', '3', '4', '5', '6', '7']);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve.mock.calls.map(([keys]) => keys.length)).toEqual([3, 3, 1]);
  });

  it('a failed request is not remembered and the waiter still settles', async () => {
    const resolve = vi.fn(() => Promise.reject(new Error('RATE_LIMITED')));
    const resolver = createBatchedResolver({
      delayMs: 1, ttlMs: 1_000, chunk: 100, resolve,
    });
    const waiting = resolver.request(['a@x']);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(resolver.isFresh('a@x')).toBe(false);
  });
});
