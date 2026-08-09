// Кастомные стикер-паки: контейнер PVPK1 (байт-совместим с desktop-форком:
// "PVPK1" + u32LE-длина JSON-индекса + индекс [{"name","size"}...] + байты
// файлов подряд), persist установленных паков в IndexedDB, реестр pack_ref
// принятых стикеров. Обмен: отправляемый стикер из пака несёт
// pack_ref = {file_id архива в cloud, name, count, key, nonce}.

import { createStore, del, get, set } from 'idb-keyval';

import type { ApiSticker, ApiStickerSet } from '../types';
import type { WirePackRef } from './wire';

const PACK_MAGIC = 'PVPK1';
const PACK_MAX_BYTES = 20 * 1024 * 1024;
const PACK_MAX_FILES = 200;
const SET_ID_PREFIX = 'pvpk-';
const STICKER_SIZE = 512;
const DEFAULT_ALT_EMOJI = '🙂';
const STORAGE = createStore('parvane-stickers', 'packs');

export type PackFile = { name: string; data: ArrayBuffer };
export type StoredPack = { name: string; files: PackFile[] };

const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  tgs: 'application/x-tgsticker',
  webm: 'video/webm',
};

// pack_ref принятых стикеров: setId → ref (до установки — источник архива)
const receivedRefBySetId = new Map<string, WirePackRef>();
// Распакованные файлы набора, показанного в модалке, но ещё не установленного
const pendingFilesBySetId = new Map<string, StoredPack>();
const setIdByShortName = new Map<string, string>();

// FNV-1a 32-бит — как IdForAddress в store; даёт стабильный короткий id
function buildHashedId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash >>> 1);
}

// Зеркало desktop SanitizePackName: буквы/цифры/пробел/дефис/подчёркивание, ≤32
export function sanitizePackName(name: string) {
  const cleaned = Array.from(name)
    .filter((ch) => /[\p{L}\p{N} _-]/u.test(ch))
    .join('')
    .trim()
    .slice(0, 32);
  return cleaned || 'Pack';
}

export function getSetIdForPackName(name: string) {
  return `${SET_ID_PREFIX}${buildHashedId(`pack:${name}`)}`;
}

export function isCustomPackSetId(id?: string) {
  return Boolean(id?.startsWith(SET_ID_PREFIX));
}

export function getPackFileMime(fileName: string) {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  return MIME_BY_EXT[ext];
}

// ── PVPK1 ────────────────────────────────────────────────────────────────────

export function buildPvpkArchive(files: PackFile[]): Uint8Array | undefined {
  const encoder = new TextEncoder();
  const index: { name: string; size: number }[] = [];
  const blobs: Uint8Array[] = [];
  let total = 0;
  for (const file of files.slice(0, PACK_MAX_FILES)) {
    if (!getPackFileMime(file.name)) continue;
    const bytes = new Uint8Array(file.data);
    if (total + bytes.length > PACK_MAX_BYTES) break;
    total += bytes.length;
    index.push({ name: file.name, size: bytes.length });
    blobs.push(bytes);
  }
  if (!index.length) return undefined;
  const indexBytes = encoder.encode(JSON.stringify(index));
  const out = new Uint8Array(5 + 4 + indexBytes.length + total);
  out.set(encoder.encode(PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(5, indexBytes.length, true);
  out.set(indexBytes, 9);
  let offset = 9 + indexBytes.length;
  for (const bytes of blobs) {
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

// Распаковка с санитизацией: только basename и знакомые расширения
export function parsePvpkArchive(bytes: Uint8Array): PackFile[] | undefined {
  if (bytes.length < 9 || bytes.length > PACK_MAX_BYTES + (1 << 20)) return undefined;
  const decoder = new TextDecoder();
  if (decoder.decode(bytes.subarray(0, 5)) !== PACK_MAGIC) return undefined;
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(5, true);
  if (9 + len > bytes.length) return undefined;
  let index: { name?: string; size?: number }[];
  try {
    index = JSON.parse(decoder.decode(bytes.subarray(9, 9 + len)));
  } catch {
    return undefined;
  }
  if (!Array.isArray(index) || index.length > PACK_MAX_FILES) return undefined;
  const files: PackFile[] = [];
  let offset = 9 + len;
  for (const entry of index) {
    const name = String(entry.name || '').split(/[\\/]/).pop() || '';
    const size = Number(entry.size) || 0;
    if (offset + size > bytes.length) break;
    if (name && size > 0 && getPackFileMime(name)) {
      files.push({ name, data: bytes.slice(offset, offset + size).buffer });
    }
    offset += size;
  }
  return files.length ? files : undefined;
}

// ── persist установленных паков (IndexedDB, ключ на пользователя) ────────────

function storageKey(user: string) {
  return `packs:${user}`;
}

export async function loadInstalledPacks(user: string): Promise<StoredPack[]> {
  return (await get<StoredPack[]>(storageKey(user), STORAGE)) || [];
}

export async function saveInstalledPack(user: string, pack: StoredPack) {
  const packs = (await loadInstalledPacks(user)).filter(({ name }) => name !== pack.name);
  packs.push(pack);
  await set(storageKey(user), packs, STORAGE);
}

export async function removeInstalledPack(user: string, name: string) {
  const packs = (await loadInstalledPacks(user)).filter((pack) => pack.name !== name);
  if (packs.length) await set(storageKey(user), packs, STORAGE);
  else await del(storageKey(user), STORAGE);
}

export async function findInstalledPackBySetId(user: string, setId: string) {
  return (await loadInstalledPacks(user)).find((pack) => getSetIdForPackName(pack.name) === setId);
}

// ── реестры сессии ───────────────────────────────────────────────────────────

export function registerReceivedPackRef(ref: WirePackRef): string {
  const name = sanitizePackName(ref.name || 'Pack');
  const setId = getSetIdForPackName(name);
  if (!receivedRefBySetId.has(setId)) {
    receivedRefBySetId.set(setId, { ...ref, name });
    setIdByShortName.set(name, setId);
  }
  return setId;
}

export function getReceivedPackRef(setId: string) {
  return receivedRefBySetId.get(setId);
}

export function resolveSetIdByShortName(shortName: string) {
  return setIdByShortName.get(shortName);
}

export function setPendingFiles(setId: string, pack: StoredPack) {
  pendingFilesBySetId.set(setId, pack);
}

export function getPendingFiles(setId: string) {
  return pendingFilesBySetId.get(setId);
}

export function resetPackRegistries() {
  receivedRefBySetId.clear();
  pendingFilesBySetId.clear();
  setIdByShortName.clear();
}

// ── синтез ApiStickerSet ─────────────────────────────────────────────────────

function buildStickerId(setId: string, fileName: string) {
  return `${setId}:${buildHashedId(fileName)}`;
}

// alt-эмодзи из hex-кода в имени файла (NN-1f602.webp) — конвенция desktop
function altEmojiForFileName(fileName: string) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const dash = base.lastIndexOf('-');
  if (dash < 0) return DEFAULT_ALT_EMOJI;
  const code = Number.parseInt(base.slice(dash + 1), 16);
  if (!Number.isInteger(code) || code < 0x80 || code > 0x10FFFF) return DEFAULT_ALT_EMOJI;
  return String.fromCodePoint(code);
}

export function buildApiStickerSetFromPack(pack: StoredPack, installedDate?: number): {
  set: ApiStickerSet;
  blobs: Map<string, { blob: Blob; mime: string }>;
} {
  const setId = getSetIdForPackName(pack.name);
  setIdByShortName.set(pack.name, setId);
  const stickers: ApiSticker[] = [];
  const blobs = new Map<string, { blob: Blob; mime: string }>();
  for (const file of pack.files) {
    const mime = getPackFileMime(file.name);
    if (!mime) continue;
    const id = buildStickerId(setId, file.name);
    stickers.push({
      mediaType: 'sticker',
      id,
      stickerSetInfo: { id: setId, accessHash: '0' },
      emoji: altEmojiForFileName(file.name),
      isLottie: mime === 'application/x-tgsticker',
      isVideo: mime === 'video/webm',
      width: STICKER_SIZE,
      height: STICKER_SIZE,
    });
    blobs.set(id, { blob: new Blob([file.data], { type: mime }), mime });
  }
  const apiSet: ApiStickerSet = {
    id: setId,
    accessHash: '0',
    title: pack.name,
    shortName: pack.name,
    count: stickers.length,
    installedDate,
    stickers,
  };
  return { set: apiSet, blobs };
}
