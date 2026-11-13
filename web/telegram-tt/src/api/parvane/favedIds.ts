// PACK-1 (spec 036): id избранного стикера у всех клиентов один — `set_id` = ключ набора STICKER_PACK
// (`h:<отпечаток содержимого>` либо `n:<имя>`, вектор `proto/parvane/vectors/clients/pack-set-id.json`), `sticker_id` —
// имя файла в архиве набора. Web показывает наборы под своими id (`setId` установки, `buildStickerId`) — здесь перевод
// в обе стороны. Записи прежнего вида (свои id web) остаются читаемыми и переводятся на общий вид при первом показе.

import type { PackFile, StoredPack } from './stickerPacks';

import { bytesToBase64 } from './v2/base64';
import {
  buildStickerId, getPackSetId, packContentHash, sanitizePackName,
} from './stickerPacks';

export type LocalStickerRef = { setId: string; stickerId: string };
export type SharedFavedId = { setId: string; stickerId: string };

/** Ключ STICKER_PACK вида PACK-1. */
export function isSharedSetId(setId: string) {
  return setId.startsWith('h:') || setId.startsWith('n:');
}

const keyCache = new WeakMap<PackFile[], Promise<string>>();

/** Ключ набора по его файлам — тот же, что `packJournalKey` ссылки с отпечатком. */
export function packKeyOf(pack: Pick<StoredPack, 'files'>) {
  let p = keyCache.get(pack.files);
  if (!p) {
    p = packContentHash(pack.files).then((hash) => `h:${bytesToBase64(hash)}`);
    keyCache.set(pack.files, p);
  }
  return p;
}

/** Своё (web) → общее. Нет набора или файла — `undefined` (остаётся прежний вид). */
export async function sharedFavedId(packs: StoredPack[], ref: LocalStickerRef): Promise<SharedFavedId | undefined> {
  if (isSharedSetId(ref.setId)) return ref;
  const pack = packs.find((p) => getPackSetId(p) === ref.setId);
  const file = pack?.files.find((f) => buildStickerId(ref.setId, f.name) === ref.stickerId);
  if (!pack || !file) return undefined;
  return { setId: await packKeyOf(pack), stickerId: file.name };
}

/** Общее → своё (web): набор с тем же отпечатком либо, у `n:`, с тем же нормализованным именем. */
export async function localStickerRef(packs: StoredPack[], faved: SharedFavedId): Promise<LocalStickerRef | undefined> {
  if (!isSharedSetId(faved.setId)) return faved;
  for (const pack of packs) {
    const matches = faved.setId.startsWith('n:')
      ? `n:${sanitizePackName(pack.rawName || pack.name)}` === faved.setId
      : await packKeyOf(pack) === faved.setId;
    if (!matches || !pack.files.some((f) => f.name === faved.stickerId)) continue;
    const setId = getPackSetId(pack);
    return { setId, stickerId: buildStickerId(setId, faved.stickerId) };
  }
  return undefined;
}
