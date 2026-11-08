import { describe, expect, it } from 'vitest';

import type { ApiSticker } from '../types';

import {
  dropStickerRef, matchStickersForEmoji, moveSetToTop, parseStickerRefs, pushStickerRef, resolveStickerRefs,
  sortSetsByOrder, stickerRefOf,
} from './stickerLists';

const sticker = (setId: string, id: string) => ({
  mediaType: 'sticker', id, stickerSetInfo: { id: setId, accessHash: '0' },
} as unknown as ApiSticker);

describe('favorite and recent stickers (A6)', () => {
  it('push puts the sticker first, deduplicates and trims to the limit', () => {
    const a = stickerRefOf(sticker('s1', 'a'))!;
    const b = stickerRefOf(sticker('s1', 'b'))!;
    const c = stickerRefOf(sticker('s2', 'c'))!;
    let list = pushStickerRef([], a, 2);
    list = pushStickerRef(list, b, 2);
    list = pushStickerRef(list, a, 2);
    expect(list).toEqual([a, b]);
    expect(pushStickerRef(list, c, 2)).toEqual([c, a]);
    expect(dropStickerRef(list, a)).toEqual([b]);
  });

  it('refs resolve from their sets in order; missing sets and stickers are skipped', async () => {
    const refs = [
      { setId: 's1', stickerId: 'b' }, { setId: 'gone', stickerId: 'x' }, { setId: 's1', stickerId: 'a' },
      { setId: 's1', stickerId: 'zz' },
    ];
    const loaded: string[] = [];
    const out = await resolveStickerRefs(refs, (setId) => {
      loaded.push(setId);
      return setId === 's1' ? Promise.resolve([sticker('s1', 'a'), sticker('s1', 'b')]) : Promise.reject(new Error());
    });
    expect(out.map((s) => s.id)).toEqual(['b', 'a']);
    expect(loaded).toEqual(['s1', 'gone']);
  });

  it('storage parse ignores garbage', () => {
    expect(parseStickerRefs([{ setId: 's', stickerId: 'x' }, { setId: 1 }, 'x']))
      .toEqual([{ setId: 's', stickerId: 'x' }]);
    expect(parseStickerRefs(undefined)).toEqual([]);
  });
});

describe('dynamic sticker set order (B12)', () => {
  it('the set of a sent sticker moves to the top, the rest keep their order', () => {
    expect(moveSetToTop(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(moveSetToTop([], 'x')).toEqual(['x']);
  });

  it('sets are shown in the saved order, unknown sets after it', () => {
    const sets = [{ id: 'builtin' }, { id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
    expect(sortSetsByOrder(sets, ['p2', 'builtin']).map((s) => s.id)).toEqual(['p2', 'builtin', 'p1', 'p3']);
  });
});

describe('sticker suggestions by emoji (B13)', () => {
  const withEmoji = (id: string, emoji: string) => ({ ...sticker('s', id), emoji } as ApiSticker);

  it('finds stickers of installed sets by emoji, ignoring the variation selector', () => {
    const list = [withEmoji('a', '😀'), withEmoji('b', '❤️'), withEmoji('c', '👋'), withEmoji('a', '😀')];
    expect(matchStickersForEmoji(list, '❤').map((s) => s.id)).toEqual(['b']);
    expect(matchStickersForEmoji(list, '😀').map((s) => s.id)).toEqual(['a']);
    expect(matchStickersForEmoji(list, '👋⭐️').map((s) => s.id)).toEqual(['c']);
    expect(matchStickersForEmoji(list, '')).toEqual([]);
  });
});
