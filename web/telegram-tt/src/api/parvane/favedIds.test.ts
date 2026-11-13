import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StoredPack } from './stickerPacks';

import { localStickerRef, packKeyOf, sharedFavedId } from './favedIds';
import { buildStickerId, packJournalKey } from './stickerPacks';

const VECTOR = resolve(__dirname, '../../../../../proto/parvane/vectors/clients/pack-set-id.json');

function file(name: string, bytes: number[]) {
  return { name, data: new Uint8Array(bytes).buffer };
}

describe('PACK-1: общий id избранного стикера', () => {
  it('ключ набора web совпадает с вектором движка', () => {
    const cases = (JSON.parse(readFileSync(VECTOR, 'utf8')) as {
      cases: { content_hash: string; pack_name: string; set_id: string }[];
    }).cases;
    for (const c of cases) {
      const key = packJournalKey({ content_hash: c.content_hash || undefined, name: c.pack_name });
      expect(key).toBe(c.set_id);
    }
  });

  it('свой id → общий (ключ по отпечатку, имя файла) → свой', async () => {
    const files = [file('a.webp', [1, 2, 3]), file('b.webp', [4])];
    const pack: StoredPack = { name: 'Котики', setId: 'pv-set-1', files };
    const stickerId = buildStickerId('pv-set-1', 'b.webp');
    const shared = await sharedFavedId([pack], { setId: 'pv-set-1', stickerId });
    expect(shared).toEqual({ setId: await packKeyOf(pack), stickerId: 'b.webp' });
    expect(shared!.setId.startsWith('h:')).toBe(true);
    // Тот же набор у другого получателя под другим своим id — тот же общий id
    const other: StoredPack = { ...pack, setId: 'pv-set-2' };
    expect(await localStickerRef([other], shared!))
      .toEqual({ setId: 'pv-set-2', stickerId: buildStickerId('pv-set-2', 'b.webp') });
  });

  it('набора нет — перевода нет; прежний вид читается как есть', async () => {
    expect(await sharedFavedId([], { setId: 'pv-x', stickerId: 'pv-x:1' })).toBeUndefined();
    expect(await localStickerRef([], { setId: 'pv-x', stickerId: 'pv-x:1' }))
      .toEqual({ setId: 'pv-x', stickerId: 'pv-x:1' });
    expect(await localStickerRef([], { setId: 'h:abc', stickerId: 'a.webp' })).toBeUndefined();
  });
});
