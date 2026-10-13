import { describe, expect, it } from 'vitest';

import { createReconnectBackoff } from './reconnectBackoff';

describe('reconnect backoff (perf A5)', () => {
  it('doubles up to the ceiling and keeps the ceiling', () => {
    const backoff = createReconnectBackoff({ baseMs: 1000, maxMs: 60000, random: () => 0.5 });
    const delays = Array.from({ length: 8 }, () => backoff.next());
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('spreads each delay within ±50 %', () => {
    const low = createReconnectBackoff({ baseMs: 1000, maxMs: 60000, random: () => 0 });
    const high = createReconnectBackoff({ baseMs: 1000, maxMs: 60000, random: () => 0.999 });
    expect(low.next()).toBe(500);
    expect(high.next()).toBe(1499);
  });

  it('starts over after reset()', () => {
    const backoff = createReconnectBackoff({ baseMs: 1000, maxMs: 60000, random: () => 0.5 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.attempts()).toBe(0);
    expect(backoff.next()).toBe(1000);
  });
});
