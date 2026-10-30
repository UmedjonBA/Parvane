import { describe, expect, it } from 'vitest';

import { v2ToWire, wireToV2 } from './contentMap';

// POLL-1: итоги анонимного опроса едут в poll_vote (tally/counts/voters), обычный голос их не несёт
describe('contentMap poll_vote tally', () => {
  it('итоги автора туда и обратно', () => {
    const v2 = wireToV2({
      kind: 'poll_vote',
      poll: '0192f0e4-1a2b-7c3d-8e4f-001122334455',
      options: [],
      tally: true,
      counts: [3, 0, 2],
      voters: 5,
    });
    expect(v2.poll_vote?.tally).toBe(true);
    expect(v2.poll_vote?.counts).toEqual([3, 0, 2]);
    const back = v2ToWire(v2) as unknown as Record<string, unknown>;
    expect(back.tally).toBe(true);
    expect(back.counts).toEqual([3, 0, 2]);
    expect(back.voters).toBe(5);
  });

  it('обычный голос без итогов', () => {
    const v2 = wireToV2({ kind: 'poll_vote', poll: '0192f0e4-1a2b-7c3d-8e4f-001122334455', options: [1] });
    expect(v2.poll_vote?.tally).toBeUndefined();
    const back = v2ToWire(v2) as unknown as Record<string, unknown>;
    expect(back.tally).toBeUndefined();
    expect(back.options).toEqual([1]);
  });
});
