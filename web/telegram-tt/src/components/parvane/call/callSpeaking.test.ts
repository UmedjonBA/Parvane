// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  measureLevel, SPEAKING_HOLD_MS, updateSpeakers,
} from './callSpeaking';

describe('Кто говорит в звонке', () => {
  it('тишина — ноль, полный размах — около единицы', () => {
    expect(measureLevel(new Uint8Array(64).fill(128))).toBe(0);
    const loud = Uint8Array.from({ length: 64 }, (_, index) => (index % 2 ? 255 : 0));
    expect(measureLevel(loud)).toBeGreaterThan(0.95);
  });

  it('держит «говорит» между словами и снимает после паузы', () => {
    let state = updateSpeakers({ bob: 0.2, carol: 0 }, {}, 1000);
    expect(state.speakers).toEqual(['bob']);
    state = updateSpeakers({ bob: 0, carol: 0 }, state.lastLoudAt, 1000 + SPEAKING_HOLD_MS - 1);
    expect(state.speakers).toEqual(['bob']);
    state = updateSpeakers({ bob: 0, carol: 0 }, state.lastLoudAt, 1000 + SPEAKING_HOLD_MS);
    expect(state.speakers).toEqual([]);
  });

  it('ушедший участник забывается', () => {
    const state = updateSpeakers({ carol: 0 }, { bob: 1000 }, 1100);
    expect(state.lastLoudAt).toEqual({});
    expect(state.speakers).toEqual([]);
  });
});
