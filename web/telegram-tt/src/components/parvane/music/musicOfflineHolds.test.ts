import { describe, expect, it } from 'vitest';

import {
  addHolds, dropHolds, EMPTY_HOLDS, syncHolds,
} from './musicOfflineHolds';

describe('offline holds', () => {
  it('a loaded playlist pulls in new tracks and lets go of removed ones', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], 'road');
    const result = syncHolds(holds, new Map([['road', ['t2', 't3']]]));
    expect(result.added).toEqual(['t3']);
    expect(result.removed).toEqual(['t1']);
    expect(result.holds.playlists).toEqual({ road: ['t2', 't3'] });
  });

  it('keeps a track that another loaded playlist or a direct download still holds', () => {
    let holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], 'road');
    holds = addHolds(holds, ['t2'], 'night');
    holds = addHolds(holds, ['t1']);
    const result = syncHolds(holds, new Map([['road', []], ['night', ['t2']]]));
    expect(result.removed).toEqual([]);
  });

  it('a deleted playlist releases its tracks and is forgotten', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1'], 'road');
    const result = syncHolds(holds, new Map());
    expect(result.removed).toEqual(['t1']);
    expect(result.holds.playlists).toEqual({});
  });

  it('unchanged playlists change nothing', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], 'road');
    const result = syncHolds(holds, new Map([['road', ['t2', 't1']]]));
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('a track removed by hand is not downloaded again by the next check', () => {
    let holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], 'road');
    holds = addHolds(holds, ['t1']);
    holds = dropHolds(holds, ['t1']);
    expect(holds).toEqual({ playlists: { road: ['t1', 't2'] }, direct: [] });
    expect(syncHolds(holds, new Map([['road', ['t1', 't2']]])).added).toEqual([]);
    expect(dropHolds(holds)).toEqual(EMPTY_HOLDS);
  });
});
