import { describe, expect, it } from 'vitest';

import { createL2Ticker } from './l2Ticks';

// Ручные таймеры: такт выполняется явно, без ожидания времени
function harness(isActive: () => boolean) {
  const timers: (() => void)[] = [];
  const sent: string[] = [];
  const ticker = createL2Ticker({
    isActive,
    send: (method) => {
      sent.push(method);
      return Promise.resolve(new Uint8Array());
    },
    makeCover: () => ({ method: 'cover', body: new Uint8Array() }),
    log: () => undefined,
    setTimer: (cb) => {
      timers.push(cb);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  const fire = async () => {
    const cb = timers.shift();
    cb?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    ticker, sent, timers, fire,
  };
}

describe('L2: ровный поток отправки (spec 025)', () => {
  it('без L2 запись уходит сразу, шума нет', async () => {
    const h = harness(() => false);
    await h.ticker.submit('msg.deliver_sealed', new Uint8Array());
    expect(h.sent).toEqual(['msg.deliver_sealed']);
    expect(h.timers).toHaveLength(0);
  });

  it('в L2 — по одной записи в такт, пустой такт — пустышка', async () => {
    const h = harness(() => true);
    const first = h.ticker.submit('msg.deliver_sealed', new Uint8Array());
    const second = h.ticker.submit('msg.deliver_group', new Uint8Array());
    expect(h.sent).toEqual([]);
    await h.fire();
    expect(h.sent).toEqual(['msg.deliver_sealed']);
    await h.fire();
    expect(h.sent).toEqual(['msg.deliver_sealed', 'msg.deliver_group']);
    await Promise.all([first, second]);
    await h.fire();
    expect(h.sent).toEqual(['msg.deliver_sealed', 'msg.deliver_group', 'cover']);
    expect(h.ticker.coversSent()).toBe(1);
  });

  it('сигналы звонка идут сразу и в L2', async () => {
    const h = harness(() => true);
    await h.ticker.submit('call.signal_sealed', new Uint8Array());
    expect(h.sent).toEqual(['call.signal_sealed']);
  });

  it('режим выключили — накопленное уходит разом, такты останавливаются', async () => {
    let isActive = true;
    const h = harness(() => isActive);
    const queued = h.ticker.submit('msg.deliver_sealed', new Uint8Array());
    void h.ticker.submit('msg.deliver_sealed', new Uint8Array());
    isActive = false;
    await h.fire();
    await queued;
    expect(h.sent).toEqual(['msg.deliver_sealed', 'msg.deliver_sealed']);
    expect(h.timers).toHaveLength(0);
  });
});
