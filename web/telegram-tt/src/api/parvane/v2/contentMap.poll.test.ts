import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { initSync } from '../../../lib/parvane-protocol/parvane_protocol';
import { contentOfWire, wireOfContent } from './contentMap';

// Виды содержимого разбирает движок (spec 035 T114) — WASM нужен и юнит-тестам
beforeAll(() => {
  initSync({ module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')) });
});

// POLL-1: итоги анонимного опроса едут в poll_vote (tally/counts/voters), обычный голос их не несёт
describe('contentMap poll_vote tally', () => {
  it('итоги автора туда и обратно', () => {
    const v2 = contentOfWire({
      kind: 'poll_vote',
      poll: '0192f0e4-1a2b-7c3d-8e4f-001122334455',
      options: [],
      tally: true,
      counts: [3, 0, 2],
      voters: 5,
    });
    expect(v2.poll_vote?.tally).toBe(true);
    expect(v2.poll_vote?.counts).toEqual([3, 0, 2]);
    const back = wireOfContent(v2) as unknown as Record<string, unknown>;
    expect(back.tally).toBe(true);
    expect(back.counts).toEqual([3, 0, 2]);
    expect(back.voters).toBe(5);
  });

  it('обычный голос без итогов', () => {
    const v2 = contentOfWire({ kind: 'poll_vote', poll: '0192f0e4-1a2b-7c3d-8e4f-001122334455', options: [1] });
    expect(v2.poll_vote?.tally).toBeUndefined();
    const back = wireOfContent(v2) as unknown as Record<string, unknown>;
    expect(back.tally).toBeUndefined();
    expect(back.options).toEqual([1]);
  });
});
