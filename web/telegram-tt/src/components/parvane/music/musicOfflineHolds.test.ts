import { describe, expect, it } from 'vitest';

import {
  addHolds, dropHolds, EMPTY_HOLDS, normalizeHolds, releaseHolder, syncHolds,
} from './musicOfflineHolds';

const ROAD = { kind: 'playlist', id: 'road' } as const;

describe('offline holds', () => {
  it('a loaded playlist pulls in new tracks and lets go of removed ones', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    const result = syncHolds(holds, new Map([['road', ['t2', 't3']]]));
    expect(result.added).toEqual(['t3']);
    expect(result.removed).toEqual(['t1']);
    expect(result.holds.playlists).toEqual({ road: ['t2', 't3'] });
  });

  it('keeps a track that another loaded playlist or a direct download still holds', () => {
    let holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    holds = addHolds(holds, ['t2'], { kind: 'playlist', id: 'night' });
    holds = addHolds(holds, ['t1']);
    const result = syncHolds(holds, new Map([['road', []], ['night', ['t2']]]));
    expect(result.removed).toEqual([]);
  });

  it('a deleted playlist releases its tracks and is forgotten', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1'], ROAD);
    const result = syncHolds(holds, new Map());
    expect(result.removed).toEqual(['t1']);
    expect(result.holds.playlists).toEqual({});
  });

  it('unchanged playlists change nothing', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    const result = syncHolds(holds, new Map([['road', ['t2', 't1']]]));
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('a track removed by hand is not downloaded again by the next check', () => {
    let holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    holds = addHolds(holds, ['t1']);
    holds = dropHolds(holds, ['t1']);
    expect(holds).toEqual({ playlists: { road: ['t1', 't2'] }, albums: {}, direct: [] });
    expect(syncHolds(holds, new Map([['road', ['t1', 't2']]])).added).toEqual([]);
    expect(dropHolds(holds)).toEqual(EMPTY_HOLDS);
  });

  it('without following new tracks the playlist only lets go of removed ones', () => {
    const holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    const result = syncHolds(holds, new Map([['road', ['t2', 't3']]]), false);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['t1']);
    expect(result.holds.playlists).toEqual({ road: ['t2'] });
  });

  it('a loaded album keeps its tracks when a playlist lets them go', () => {
    let holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    holds = addHolds(holds, ['t1', 't5'], { kind: 'album', id: 'al-1' });
    expect(syncHolds(holds, new Map([['road', ['t2']]])).removed).toEqual([]);
  });

  it('releasing a group erases only what nothing else holds', () => {
    let holds = addHolds(EMPTY_HOLDS, ['t1', 't2'], ROAD);
    holds = addHolds(holds, ['t2', 't3'], { kind: 'album', id: 'al-1' });
    holds = addHolds(holds, ['t4']);
    const byPlaylist = releaseHolder(holds, ROAD, ['t1', 't2']);
    expect(byPlaylist.released).toEqual(['t1']);
    expect(byPlaylist.holds.playlists).toEqual({});
    const single = releaseHolder(holds, undefined, ['t4']);
    expect(single.released).toEqual(['t4']);
    expect(single.holds.direct).toEqual([]);
  });

  it('records of earlier versions get an empty album list', () => {
    expect(normalizeHolds({ playlists: { road: ['t1'] }, direct: [] })).toEqual({
      playlists: { road: ['t1'] }, albums: {}, direct: [],
    });
  });
});
