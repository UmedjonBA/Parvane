// Кастомные стикер-паки: контейнер PVPK1 (байт-совместим с desktop-форком:
// "PVPK1" + u32LE-длина JSON-индекса + индекс [{"name","size"}...] + байты
// файлов подряд), persist установленных паков в IndexedDB, реестр pack_ref
// принятых стикеров. Обмен: отправляемый стикер из пака несёт
// pack_ref = {file_id архива в cloud, name, count, key, nonce}.

import { createStore, del, get } from 'idb-keyval';

import type { ApiSticker, ApiStickerSet } from '../types';
import type { WirePackRef } from './wire';

import { SecureE2eStorage } from './secureStorage';

const PACK_MAGIC = 'PVPK1';
const PACK_MAX_BYTES = 20 * 1024 * 1024;
const PACK_MAX_FILES = 200;
const SET_ID_PREFIX = 'pvpk-';
const STICKER_SIZE = 512;
const DEFAULT_ALT_EMOJI = '🙂';
const STORAGE = createStore('parvane-stickers', 'packs');

export type PackFile = { name: string; data: ArrayBuffer };
export type StoredPack = {
  name: string;
  files: PackFile[];
  isEmoji?: boolean;
  // Сырое имя пака из ссылки (docId эмодзи, EMOJI-1) и прочие имена набора
  rawName?: string;
  aliases?: string[];
  // Набор, под которым пак установлен. Имя НЕ уникально: два пака с одним
  // именем от разных отправителей — два разных набора (см. ownerBySetId), и
  // ключевать хранилище по имени значило бы затирать архив первого вторым, а
  // docId первого накладывать на файлы второго. Поле необязательное: у записей,
  // сделанных до 16 сен 2026, его нет — они мигрируют при первом чтении
  setId?: string;
};

const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  tgs: 'application/x-tgsticker',
  webm: 'video/webm',
};

// pack_ref принятых стикеров: setId → ref (до установки — источник архива)
const receivedRefBySetId = new Map<string, WirePackRef>();
// Кто прислал набор: имя пака не уникально, и два разных пака с одинаковым
// именем от РАЗНЫХ отправителей — это два разных набора. Иначе сырое имя
// второго становилось алиасом набора первого, и его docId резолвились в чужие
// картинки (имена файлов в паках конвенциональны). Отличить паки по
// содержимому нельзя: по PACK-1 один и тот же пак получает новый file_id под
// каждый набор получателей, а отпечаток содержимого — это поле провода
const ownerBySetId = new Map<string, string>();
// Распакованные файлы набора, показанного в модалке, но ещё не установленного
const pendingFilesBySetId = new Map<string, StoredPack>();
const setIdByShortName = new Map<string, string>();
// Эмодзи-паки: setId → «сырое» имя пака (docId считается от него, как в
// desktop), docId → setId (для отправки: какие паки приложить к тексту)
const emojiRawNameBySetId = new Map<string, string>();
const emojiSetIdByDocId = new Map<string, string>();
// Все имена, под которыми набор приходил в ссылках (conformance EMOJI-1):
// десктоп после рестарта может прислать тот же пак под нормализованным
// именем — документы ищем по каждому
const emojiAliasesBySetId = new Map<string, Set<string>>();
const EMOJI_SIZE = 128;

// FNV-1a 32-бит — как IdForAddress в store; даёт стабильный короткий id
function buildHashedId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash >>> 1);
}

// FNV-1a 64-бит по UTF-8 → знаковый int64 десятичной строкой — ровно как
// docIdFromFileId в desktop (parvane_client.cpp) и android (parvane_jni.cpp),
// иначе entity custom_emoji не резолвятся на другой стороне. ВНИМАНИЕ: у
// нативных клиентов начальное значение 1469598103934665603 — стандартное
// FNV-смещение 14695981039346656037 без последней цифры. Это формат провода
// (conformance EMOJI-1): считаем так же. Веб до 15 сен 2026 считал со
// стандартным смещением — такие docId резолвятся как алиасы
export const EMOJI_DOC_ID_OFFSET_BASIS = 1469598103934665603n;
const FNV64_STANDARD_OFFSET_BASIS = 0xcbf29ce484222325n;

export function fnv1a64Signed(value: string, offsetBasis = EMOJI_DOC_ID_OFFSET_BASIS): string {
  const bytes = new TextEncoder().encode(value);
  let hash = offsetBasis;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const signed = hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
  return signed.toString();
}

export function buildEmojiDocId(rawPackName: string, fileName: string) {
  return fnv1a64Signed(`pvemoji:${rawPackName}|${fileName}`);
}

// docId старых веб-сообщений (стандартное FNV-смещение) — только для резолва
export function buildLegacyEmojiDocId(rawPackName: string, fileName: string) {
  return fnv1a64Signed(`pvemoji:${rawPackName}|${fileName}`, FNV64_STANDARD_OFFSET_BASIS);
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

// ── persist установленных паков (шифрованный IndexedDB, на пользователя) ─────
// Файлы паков — полученное от других медиа: на диске только шифртекстом
// (SecureE2eStorage, non-extractable ключ устройства). Раньше лежали открыто в
// idb-keyval `parvane-stickers/packs` — переносим при первом чтении.

type StoredPackMeta = {
  name: string; setId?: string; isEmoji?: boolean; rawName?: string; aliases?: string[];
};

const PACK_INDEX_RECORD = 'stickerpacks';
const packRecordName = (key: string) => `stickerpack:${key}`;
const installedCache = new Map<string, Promise<StoredPack[]>>();

// Набор установленного пака. У записей без `setId` (до 16 сен 2026) он выводится
// из имени — ровно тот id, под которым такой пак и был установлен
export function getPackSetId(pack: StoredPackMeta) {
  return pack.setId || getSetIdForPackName(pack.name);
}

// Ключ записи архива. Пока `setId` не проставлен, запись лежит под именем —
// иначе миграция не нашла бы уже сохранённые байты
const packStorageKey = (pack: StoredPackMeta) => pack.setId || pack.name;

function storageKey(user: string) {
  return `packs:${user}`;
}

function toMeta({
  name, setId, isEmoji, rawName, aliases,
}: StoredPack): StoredPackMeta {
  return {
    name, setId, isEmoji, rawName, aliases,
  };
}

async function writePack(storage: SecureE2eStorage, pack: StoredPack) {
  const archive = buildPvpkArchive(pack.files);
  if (!archive) return false;
  await storage.saveBytesRecord(packRecordName(packStorageKey(pack)), archive);
  return true;
}

async function readInstalledPacks(user: string): Promise<StoredPack[]> {
  const storage = await SecureE2eStorage.open(user);
  let index = await storage.loadRecord<StoredPackMeta[]>(PACK_INDEX_RECORD) || [];
  const legacy = await get<StoredPack[]>(storageKey(user), STORAGE);
  if (legacy?.length) {
    for (const pack of legacy) {
      const migrated = { ...pack, setId: getPackSetId(pack) };
      if (await writePack(storage, migrated)) {
        index = index.filter((meta) => getPackSetId(meta) !== migrated.setId).concat(toMeta(migrated));
      }
    }
    await storage.saveRecord(PACK_INDEX_RECORD, index);
    await del(storageKey(user), STORAGE);
  }
  // Записи без `setId` лежат под именем пака — переносим под ключ набора, иначе
  // одноимённый пак второго отправителя перетёр бы их архив
  const stale = index.filter((meta) => !meta.setId);
  if (stale.length) {
    for (const meta of stale) {
      const bytes = await storage.loadBytesRecord(packRecordName(meta.name));
      if (!bytes) continue;
      meta.setId = getPackSetId(meta);
      await storage.saveBytesRecord(packRecordName(meta.setId), bytes);
      await storage.deleteRecord(packRecordName(meta.name));
    }
    await storage.saveRecord(PACK_INDEX_RECORD, index);
  }
  const packs: StoredPack[] = [];
  for (const meta of index) {
    const bytes = await storage.loadBytesRecord(packRecordName(packStorageKey(meta)));
    const files = bytes ? parsePvpkArchive(bytes) : undefined;
    if (files) packs.push({ ...meta, files });
  }
  return packs;
}

export function loadInstalledPacks(user: string): Promise<StoredPack[]> {
  let cached = installedCache.get(user);
  if (!cached) {
    cached = readInstalledPacks(user).catch(() => []);
    installedCache.set(user, cached);
  }
  return cached;
}

export async function saveInstalledPack(user: string, pack: StoredPack) {
  const storage = await SecureE2eStorage.open(user);
  const stored: StoredPack = { ...pack, setId: getPackSetId(pack) };
  if (!await writePack(storage, stored)) return;
  const index = (await storage.loadRecord<StoredPackMeta[]>(PACK_INDEX_RECORD) || [])
    .filter((meta) => getPackSetId(meta) !== stored.setId)
    .concat(toMeta(stored));
  await storage.saveRecord(PACK_INDEX_RECORD, index);
  installedCache.delete(user);
}

export async function removeInstalledPack(user: string, setId: string) {
  const storage = await SecureE2eStorage.open(user);
  const all = await storage.loadRecord<StoredPackMeta[]>(PACK_INDEX_RECORD) || [];
  const removed = all.filter((meta) => getPackSetId(meta) === setId);
  if (!removed.length) return;
  for (const meta of removed) {
    await storage.deleteRecord(packRecordName(packStorageKey(meta)));
  }
  await storage.saveRecord(PACK_INDEX_RECORD, all.filter((meta) => getPackSetId(meta) !== setId));
  installedCache.delete(user);
}

export async function findInstalledPackBySetId(user: string, setId: string) {
  return (await loadInstalledPacks(user)).find((pack) => getPackSetId(pack) === setId);
}

export function resetInstalledPacksCache() {
  installedCache.clear();
}

// ── реестры сессии ───────────────────────────────────────────────────────────

// Набор второго отправителя с тем же именем получает собственный setId: имя
// пака дополняется адресом отправителя. Разделитель —  , он невозможен в
// адресе и в имени пака, поэтому коллизию «имя+отправитель» не породит
function setIdForSender(name: string, from: string) {
  return getSetIdForPackName(`${name} ${from}`);
}

export function registerReceivedPackRef(ref: WirePackRef, from?: string): string {
  const name = sanitizePackName(ref.name || 'Pack');
  const baseSetId = getSetIdForPackName(name);
  const owner = from || '';
  const knownOwner = ownerBySetId.get(baseSetId);
  // Имя занято другим отправителем — заводим отдельный набор под этого
  const setId = receivedRefBySetId.has(baseSetId) && knownOwner !== undefined
    && owner && knownOwner && knownOwner !== owner
    ? setIdForSender(name, owner)
    : baseSetId;
  if (!receivedRefBySetId.has(setId)) {
    receivedRefBySetId.set(setId, { ...ref, name });
    ownerBySetId.set(setId, owner);
    // Короткое имя ведёт на первый пришедший набор — как и раньше
    if (!setIdByShortName.has(name)) setIdByShortName.set(name, setId);
  }
  return setId;
}

// Эмодзи-пак, приложенный к тексту (emoji_packs): регистрируем как обычный
// pack_ref + помним сырое имя для docId
export function registerReceivedEmojiPackRef(ref: WirePackRef, from?: string): string {
  const setId = registerReceivedPackRef(ref, from);
  const rawName = ref.name || 'Pack';
  if (!emojiRawNameBySetId.has(setId)) emojiRawNameBySetId.set(setId, rawName);
  // Алиас ложится только на набор ЭТОГО отправителя
  addEmojiPackAlias(setId, rawName);
  return setId;
}

export function addEmojiPackAlias(setId: string, name: string) {
  let aliases = emojiAliasesBySetId.get(setId);
  if (!aliases) {
    aliases = new Set();
    emojiAliasesBySetId.set(setId, aliases);
  }
  aliases.add(name);
}

// Имена, от которых считаются docId набора: сохранённое сырое, имя реестра,
// все имена из ссылок и нормализованное
export function getEmojiPackNames(setId: string, pack?: Pick<StoredPack, 'name' | 'rawName' | 'aliases'>) {
  const names = new Set<string>();
  if (pack?.rawName) names.add(pack.rawName);
  const registered = emojiRawNameBySetId.get(setId);
  if (registered) names.add(registered);
  pack?.aliases?.forEach((name) => names.add(name));
  emojiAliasesBySetId.get(setId)?.forEach((name) => names.add(name));
  if (pack?.name) names.add(pack.name);
  return Array.from(names);
}

export function registerEmojiDocId(docId: string, setId: string) {
  emojiSetIdByDocId.set(docId, setId);
}

export function registerEmojiPackName(setId: string, rawName: string) {
  emojiRawNameBySetId.set(setId, rawName);
}

export function isEmojiPackSetId(setId: string) {
  return emojiRawNameBySetId.has(setId);
}

export function getEmojiPackRawName(setId: string) {
  return emojiRawNameBySetId.get(setId);
}

export function getEmojiSetIdForDocId(docId: string) {
  return emojiSetIdByDocId.get(docId);
}

export function getReceivedEmojiPackSetIds() {
  return Array.from(emojiRawNameBySetId.keys());
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
  installedCache.clear();
  receivedRefBySetId.clear();
  ownerBySetId.clear();
  pendingFilesBySetId.clear();
  setIdByShortName.clear();
  emojiRawNameBySetId.clear();
  emojiSetIdByDocId.clear();
  emojiAliasesBySetId.clear();
  // Документы паков предыдущего аккаунта не должны резолвиться в новом:
  // `fetchCustomEmoji` ходит сюда по docId, а docId детерминирован от имени
  // пака и файла — у другого аккаунта он совпадёт и отдал бы чужие картинки
  aliasStickers.clear();
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

export function altEmojiForPackFile(fileName: string) {
  return altEmojiForFileName(fileName);
}

// Эмодзи-набор из пака: id документа = docId(rawName|file) (общий с desktop),
// isCustomEmoji — рендер инлайн по entity; медиа-хэш document<docId>
export function buildApiCustomEmojiSetFromPack(
  pack: StoredPack, rawName: string, setId: string, installedDate?: number,
): { set: ApiStickerSet; blobs: Map<string, { blob: Blob; mime: string }> } {
  registerEmojiPackName(setId, rawName);
  setIdByShortName.set(pack.name, setId);
  const stickers: ApiSticker[] = [];
  const blobs = new Map<string, { blob: Blob; mime: string }>();
  // Документы под остальными именами набора (EMOJI-1): не показываются в
  // панели, но резолвят entity, пришедшие под другим именем пака
  const aliasDocIds = (name: string, fileName: string) => (name === rawName
    ? [buildLegacyEmojiDocId(name, fileName)]
    : [buildEmojiDocId(name, fileName), buildLegacyEmojiDocId(name, fileName)]);
  getEmojiPackNames(setId, pack).forEach((alias) => {
    pack.files.forEach((file) => aliasDocIds(alias, file.name).forEach((id) => {
      const mime = getPackFileMime(file.name);
      if (!mime) return;
      emojiSetIdByDocId.set(id, setId);
      aliasStickers.set(id, {
        mediaType: 'sticker',
        id,
        stickerSetInfo: { id: setId, accessHash: '0' },
        emoji: altEmojiForFileName(file.name),
        isCustomEmoji: true,
        isLottie: mime === 'application/x-tgsticker',
        isVideo: mime === 'video/webm',
        width: EMOJI_SIZE,
        height: EMOJI_SIZE,
      });
      blobs.set(id, { blob: new Blob([file.data], { type: mime }), mime });
    }));
  });
  for (const file of pack.files) {
    const mime = getPackFileMime(file.name);
    if (!mime) continue;
    const id = buildEmojiDocId(rawName, file.name);
    emojiSetIdByDocId.set(id, setId);
    stickers.push({
      mediaType: 'sticker',
      id,
      stickerSetInfo: { id: setId, accessHash: '0' },
      emoji: altEmojiForFileName(file.name),
      isCustomEmoji: true,
      isLottie: mime === 'application/x-tgsticker',
      isVideo: mime === 'video/webm',
      width: EMOJI_SIZE,
      height: EMOJI_SIZE,
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
    isEmoji: true,
    stickers,
  };
  return { set: apiSet, blobs };
}

// Документы-алиасы эмодзи (другие имена набора), зарегистрированные при сборке
const aliasStickers = new Map<string, ApiSticker>();

export function getAliasEmojiSticker(docId: string) {
  return aliasStickers.get(docId);
}

export function registerAliasEmojiSticker(sticker: ApiSticker, setId: string) {
  aliasStickers.set(sticker.id, sticker);
  emojiSetIdByDocId.set(sticker.id, setId);
}

export function buildApiStickerSetFromPack(pack: StoredPack, installedDate?: number): {
  set: ApiStickerSet;
  blobs: Map<string, { blob: Blob; mime: string }>;
} {
  const setId = getPackSetId(pack);
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
