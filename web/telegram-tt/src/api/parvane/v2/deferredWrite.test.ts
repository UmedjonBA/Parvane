import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createDeferredWrite } from './deferredWrite';

describe('deferred state write (perf A1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeWriter(debounceMs = 400, maxDelayMs = 2000) {
    let revision = 0;
    const store = vi.fn(() => Promise.resolve());
    const writer = createDeferredWrite<number>({
      debounceMs, maxDelayMs, snapshot: () => revision, store,
    });
    return {
      writer,
      store,
      bump: () => {
        revision += 1;
        writer.mark();
      },
    };
  }

  it('coalesces a burst of changes into one write after the debounce', async () => {
    const { store, bump } = makeWriter();
    bump();
    bump();
    bump();
    await vi.advanceTimersByTimeAsync(399);
    expect(store).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toBe(3);
  });

  it('writes no later than maxDelay after the first change under constant churn', async () => {
    const { store, bump } = makeWriter(400, 2000);
    for (let i = 0; i < 10; i++) {
      bump();
      await vi.advanceTimersByTimeAsync(300);
    }
    // 3000 мс непрерывных изменений: предел 2 с сработал
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('flush() writes the current snapshot immediately and only when dirty', async () => {
    const { writer, store, bump } = makeWriter();
    await writer.flush();
    expect(store).not.toHaveBeenCalled();
    bump();
    await writer.flush();
    expect(store).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store).toHaveBeenCalledTimes(1);
    expect(writer.isDirty()).toBe(false);
  });

  it('discard() drops the pending snapshot and settled() waits for writes in flight', async () => {
    let release: (() => void) | undefined;
    const store = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const writer = createDeferredWrite<string>({
      debounceMs: 400, maxDelayMs: 2000, snapshot: () => 'snap', store,
    });
    writer.mark();
    void writer.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(store).toHaveBeenCalledTimes(1);
    writer.mark();
    writer.discard();
    let isSettled = false;
    void writer.settled().then(() => {
      isSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isSettled).toBe(false);
    release!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(isSettled).toBe(true);
    // отменённая отметка записи не породила
    expect(store).toHaveBeenCalledTimes(1);
    expect(writer.isDirty()).toBe(false);
  });

  it('serialises writes and reports failures without breaking the chain', async () => {
    const onError = vi.fn();
    const order: string[] = [];
    const writer = createDeferredWrite<string>({
      debounceMs: 1,
      maxDelayMs: 10,
      snapshot: () => 'snap',
      store: (value) => {
        order.push(value);
        return order.length === 1 ? Promise.reject(new Error('disk')) : Promise.resolve();
      },
      onError,
    });
    writer.mark();
    const first = writer.flush();
    writer.mark();
    const second = writer.flush();
    await Promise.all([first, second]);
    expect(order).toEqual(['snap', 'snap']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
