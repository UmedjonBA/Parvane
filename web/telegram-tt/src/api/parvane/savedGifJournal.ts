// Свои GIF на всех своих устройствах (GIF-1, 7 ноя 2026): носитель — журнал личного состояния, вид `packs`
// (PACK-3). Запись `g:<sha256 файла, hex>` ссылается на сам файл GIF, а не на архив набора

import type { LocalStickerPack } from './localState';

import { base64ToBytes, bytesToBase64 } from './v2/base64';

const GIF_KEY_PREFIX = 'g:';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DEFAULT_GIF_MIME = 'video/mp4';
const GIF_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  gif: 'image/gif',
};
const GIF_EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/gif': 'gif',
};

export type GifJournalRef = {
  hashHex: string;
  fileId: string;
  name: string;
  mimeType: string;
  key?: string;
  nonce?: string;
  capability?: string;
  blobDomain?: string;
  addedMs: number;
};

export function buildGifJournalKey(hashHex: string) {
  return `${GIF_KEY_PREFIX}${hashHex}`;
}

export function isGifJournalKey(setId: string) {
  return setId.startsWith(GIF_KEY_PREFIX);
}

/** Хеш из ключа `g:<hex>`; не тот вид ключа или не 64 hex — undefined. */
export function getGifHashFromKey(setId: string) {
  if (!isGifJournalKey(setId)) return undefined;
  const hashHex = setId.slice(GIF_KEY_PREFIX.length).toLowerCase();
  return SHA256_HEX.test(hashHex) ? hashHex : undefined;
}

/** Записи журнала `packs`: наборы стикеров — путь PACK-3, записи `g:` — сохранённые GIF. */
export function splitJournalPacks(packs: LocalStickerPack[], removed: string[]) {
  return {
    packs: packs.filter((pack) => !isGifJournalKey(pack.set_id)),
    removed: removed.filter((setId) => !isGifJournalKey(setId)),
    gifs: packs.filter((pack) => isGifJournalKey(pack.set_id)),
    removedGifs: removed.filter(isGifJournalKey),
  };
}

export async function computeSha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Файл совпадает с ключом записи: sha256 содержимого = hex в `set_id`. */
export async function verifyGifBytes(bytes: Uint8Array<ArrayBuffer>, setId: string) {
  const expected = getGifHashFromKey(setId);
  return Boolean(expected) && await computeSha256Hex(bytes) === expected;
}

export function getGifMimeFromName(name?: string) {
  const ext = name?.split('.').pop()?.toLowerCase();
  return (ext && GIF_MIME_BY_EXT[ext]) || DEFAULT_GIF_MIME;
}

/** Имя файла с расширением по типу — по нему другие клиенты узнают тип (GIF-1 п. 2). */
export function buildGifFileName(baseName: string, mimeType: string) {
  const ext = GIF_EXT_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()];
  if (!ext) return baseName;
  const stem = baseName.replace(/\.[^/.]+$/, '') || 'animation';
  return `${stem}.${ext}`;
}

export function buildGifJournalEntry(ref: GifJournalRef): LocalStickerPack {
  const hashBytes = new Uint8Array(ref.hashHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  return {
    set_id: buildGifJournalKey(ref.hashHex),
    ref: {
      file_id: ref.fileId,
      name: buildGifFileName(ref.name, ref.mimeType),
      count: 1,
      key: ref.key,
      nonce: ref.nonce,
      capability: ref.capability,
      content_hash: bytesToBase64(hashBytes),
      blob_domain: ref.blobDomain,
    },
    emoji: undefined,
    added_ms: String(ref.addedMs),
  };
}

/** Запись `g:` журнала → ссылка на файл; негодная (без хеша, файла или с чужим `content_hash`) — undefined. */
export function parseGifJournalEntry(entry: LocalStickerPack): GifJournalRef | undefined {
  const hashHex = getGifHashFromKey(entry.set_id);
  if (!hashHex || !entry.ref?.file_id) return undefined;
  if (entry.ref.content_hash) {
    let contentHash: Uint8Array;
    try {
      contentHash = base64ToBytes(entry.ref.content_hash);
    } catch {
      return undefined;
    }
    const contentHex = Array.from(contentHash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (contentHex !== hashHex) return undefined;
  }
  const name = entry.ref.name || 'animation.mp4';
  return {
    hashHex,
    fileId: entry.ref.file_id,
    name,
    mimeType: getGifMimeFromName(name),
    key: entry.ref.key,
    nonce: entry.ref.nonce,
    capability: entry.ref.capability,
    blobDomain: entry.ref.blob_domain,
    addedMs: Number(entry.added_ms) || 0,
  };
}

/** Новые первыми: порядок вставки в начало списка — от старых к новым. */
export function sortGifEntriesOldestFirst(entries: GifJournalRef[]) {
  return [...entries].sort((a, b) => a.addedMs - b.addedMs);
}
