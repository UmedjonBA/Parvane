import type { MusicStreamQuality, MusicTrack } from '../../../api/parvane/musicApi';
import type { OfflineHolder, OfflineHolds } from './musicOfflineHolds';

import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';
import {
  addHolds, dropHolds, EMPTY_HOLDS, normalizeHolds, releaseHolder,
} from './musicOfflineHolds';
import { callMusic } from './musicPlayer';

// Parvane (spec 039, 041 C3): «Загруженное» — треки, сохранённые на устройстве для игры без сети. Файл трека
// лежит в хранилище браузера (Cache Storage), список — рядом; плеер сначала ищет трек здесь. Треки общей
// библиотеки сервер и так видит, поэтому файлы хранятся как есть, без шифрования. Очередь загрузки можно
// поставить на паузу и отменить; без связи она ждёт и продолжается сама (доски `XpMusic`, `RdMusic`)

export type OfflineEntry = {
  track: MusicTrack;
  bytes: number;
  savedMs: number;
};

// Что качается сейчас: плейлист, альбом либо отдельные треки
export type OfflineBatch = { holder?: OfflineHolder };

export type OfflineState = {
  entries: OfflineEntry[];
  // Очередь скачивания: сколько треков осталось вместе с текущим и сколько было в начале
  pending: number;
  total: number;
  problem?: 'limit' | 'failed';
  batch?: OfflineBatch;
  // Пауза: руками либо без связи (`isWaitingNetwork`) — тогда продолжится сама
  isPaused?: boolean;
  isWaitingNetwork?: boolean;
  // Для оценки «примерно N минут · M МБ»: скачано байт и сколько длилось в этой очереди
  doneBytes: number;
  busyMs: number;
};

// Настройки устройства (доски `XpMusic`, `RdMusic`; «Данные и память»)
export type OfflineSettings = {
  limitBytes: number;
  quality: MusicStreamQuality;
  // «Скачивать новое в загруженных плейлистах»
  shouldFollowNew: boolean;
};

const CACHE_NAME = 'parvane-music-offline';
const INDEX_KEY = 'parvane:music-offline';
// Почему треки на устройстве: загруженные плейлисты, альбомы и их состав (`musicOfflineHolds.ts`)
const HOLDS_KEY = 'parvane:music-offline-holds';
const SETTINGS_KEY = 'parvane:music-offline-settings';
const GB = 1024 * 1024 * 1024;
// Выбор предела в «Данные и память»
export const OFFLINE_LIMIT_CHOICES = [GB / 2, GB, 2 * GB, 5 * GB, 10 * GB];
const DEFAULT_SETTINGS: OfflineSettings = { limitBytes: GB, quality: 'original', shouldFollowNew: true };

const [getOfflineState, setOfflineState] = createSignal<OfflineState>({
  entries: readJson<OfflineEntry[]>(INDEX_KEY) || [], pending: 0, total: 0, doneBytes: 0, busyMs: 0,
});
const [getOfflineSettings, setOfflineSettingsSignal] = createSignal<OfflineSettings>({
  ...DEFAULT_SETTINGS, ...readJson<Partial<OfflineSettings>>(SETTINGS_KEY),
});

export { getOfflineSettings, getOfflineState };

const queue: { track: MusicTrack; batch: OfflineBatch }[] = [];
const objectUrls = new Map<string, string>();
let isRunning = false;
// Трек, который качается сейчас (из очереди он уже взят)
let currentId: string | undefined;
let holds = normalizeHolds(readJson<OfflineHolds>(HOLDS_KEY));

if (typeof window !== 'undefined') {
  // Выход из аккаунта: файлы стёрты вместе с кэшем (`deviceWipe.ts`), в памяти вкладки их списка тоже нет
  window.addEventListener(ACCOUNT_WIPED_EVENT, forgetOffline);
  // Связь вернулась — очередь, ждавшая сеть, продолжается сама
  window.addEventListener('online', () => {
    if (getOfflineState().isWaitingNetwork) resumeOffline();
  });
}

function forgetOffline() {
  holds = EMPTY_HOLDS;
  queue.length = 0;
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
  setOfflineState({
    entries: [], pending: 0, total: 0, doneBytes: 0, busyMs: 0,
  });
  setOfflineSettingsSignal(DEFAULT_SETTINGS);
}

function readJson<T>(key: string): T | undefined {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Память устройства недоступна: значение живёт до перезагрузки
  }
}

export function getOfflineHolds() {
  return holds;
}

export function setOfflineHolds(next: OfflineHolds) {
  holds = next;
  writeJson(HOLDS_KEY, next);
}

export function setOfflineSettings(change: Partial<OfflineSettings>) {
  const next = { ...getOfflineSettings(), ...change };
  setOfflineSettingsSignal(next);
  writeJson(SETTINGS_KEY, next);
}

export function getOfflineQuality() {
  return getOfflineSettings().quality;
}

function publish(change: Partial<OfflineState>) {
  const next = { ...getOfflineState(), ...change };
  setOfflineState(next);
  if (change.entries) writeJson(INDEX_KEY, next.entries);
}

function requestOf(trackId: string) {
  return new Request(`/__parvane-music-offline/${encodeURIComponent(trackId)}`);
}

export function isTrackOffline(trackId: string) {
  return getOfflineState().entries.some((entry) => entry.track.id === trackId);
}

/** Трек ждёт загрузки либо качается сейчас. */
export function isTrackSaving(trackId: string) {
  return currentId === trackId || queue.some((item) => item.track.id === trackId);
}

export function getOfflineBytes(state = getOfflineState()) {
  return state.entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

/** Адрес сохранённого трека для плеера; трека на устройстве нет — `undefined`. */
export async function loadOfflineUrl(trackId: string) {
  if (!isTrackOffline(trackId)) return undefined;
  const known = objectUrls.get(trackId);
  if (known) return known;
  try {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(requestOf(trackId));
    if (!saved) return undefined;
    const url = URL.createObjectURL(await saved.blob());
    objectUrls.set(trackId, url);
    return url;
  } catch {
    return undefined;
  }
}

/** Сохранить треки на устройстве: уже сохранённые и стоящие в очереди пропускаются. `holder` — загружается
 * плейлист либо альбом целиком (`tracks` — весь состав): плейлист дальше следует за составом
 * (`musicOfflineSync.ts`), «Загруженное» показывает их группами. */
export function saveTracksOffline(tracks: MusicTrack[], holder?: OfflineHolder) {
  requestPersistentStorage();
  setOfflineHolds(addHolds(holds, tracks.map((track) => track.id), holder));
  queueOfflineTracks(tracks, holder);
}

// Без «постоянного» хранилища браузер считает кэш временным: при нехватке места (и в Safari через 7 дней без
// открытия) скачанное стирается. Просьба — один раз; браузер решает сам (у установленной PWA обычно соглашается)
let isPersistAsked = false;

function requestPersistentStorage() {
  if (isPersistAsked || !navigator.storage?.persist) return;
  isPersistAsked = true;
  void navigator.storage.persisted()
    .then((isPersisted) => (isPersisted ? undefined : navigator.storage.persist()))
    .catch(() => undefined);
}

/** Докачать треки, отметки которых уже стоят (сверка загруженного плейлиста). */
export function queueOfflineTracks(tracks: MusicTrack[], holder?: OfflineHolder) {
  const fresh = tracks.filter((track) => !isTrackOffline(track.id) && !isTrackSaving(track.id));
  if (!fresh.length) return;
  const batch = { holder };
  queue.push(...fresh.map((track) => ({ track, batch })));
  const state = getOfflineState();
  const isFresh = !state.pending;
  publish({
    pending: queue.length + (isRunning ? 1 : 0),
    total: (isFresh ? 0 : state.total) + fresh.length,
    problem: undefined,
    batch: isFresh || !state.batch ? batch : state.batch,
    doneBytes: isFresh ? 0 : state.doneBytes,
    busyMs: isFresh ? 0 : state.busyMs,
  });
  if (!isRunning && !state.isPaused) void runQueue();
}

export function pauseOffline() {
  if (!getOfflineState().pending) return;
  publish({ isPaused: true, isWaitingNetwork: false });
}

export function resumeOffline() {
  publish({ isPaused: false, isWaitingNetwork: false, problem: undefined });
  if (!isRunning && queue.length) void runQueue();
}

/** Отменить очередь загрузки: уже скачанное остаётся. */
export function cancelOffline() {
  queue.length = 0;
  publish({
    pending: isRunning ? 1 : 0, total: isRunning ? 1 : 0, isPaused: false, isWaitingNetwork: false, batch: undefined,
  });
}

async function runQueue() {
  isRunning = true;
  while (queue.length && !getOfflineState().isPaused) {
    const { track, batch } = queue.shift()!;
    currentId = track.id;
    publish({ batch });
    const startedMs = Date.now();
    const outcome = await saveOne(track);
    currentId = undefined;
    if (outcome === 'failed' && !navigator.onLine) {
      // Нет связи: трек — обратно в начало, очередь ждёт сеть и продолжится сама
      queue.unshift({ track, batch });
      publish({ isPaused: true, isWaitingNetwork: true });
      break;
    }
    if (outcome !== 'saved') {
      // Места нет либо сервер отказал: остальное не качается, пока человек не попросит снова
      queue.length = 0;
      publish({
        pending: 0, total: 0, problem: outcome, batch: undefined,
      });
      isRunning = false;
      return;
    }
    const state = getOfflineState();
    const saved = state.entries.find((entry) => entry.track.id === track.id);
    publish({
      pending: queue.length,
      doneBytes: state.doneBytes + (saved?.bytes || 0),
      busyMs: state.busyMs + Date.now() - startedMs,
    });
  }
  isRunning = false;
  if (!queue.length) publish({ pending: 0, total: 0, batch: undefined });
}

async function saveOne(track: MusicTrack): Promise<'saved' | 'limit' | 'failed'> {
  try {
    const link = await callMusic('parvaneMusicStreamUrl', {
      trackId: track.id, quality: getOfflineQuality(), isDownload: true,
    });
    const response = await fetch(link.url);
    if (!response.ok) return 'failed';
    const blob = await response.blob();
    if (getOfflineBytes() + blob.size > getOfflineSettings().limitBytes) return 'limit';
    const cache = await caches.open(CACHE_NAME);
    await cache.put(requestOf(track.id), new Response(blob, { headers: { 'content-type': blob.type || link.mime } }));
    const entries = [...getOfflineState().entries.filter((entry) => entry.track.id !== track.id), {
      track, bytes: blob.size, savedMs: Date.now(),
    }];
    publish({ entries });
    return 'saved';
  } catch {
    return 'failed';
  }
}

/** Убрать треки с устройства; без списка — всё загруженное. */
export async function removeOffline(trackIds?: string[]) {
  setOfflineHolds(dropHolds(holds, trackIds));
  await eraseTracks(trackIds || getOfflineState().entries.map((entry) => entry.track.id));
}

/** «Убрать» группу «Загруженного»: плейлист, альбом либо отдельные треки (`holder` не задан). */
export async function removeOfflineGroup(holder: OfflineHolder | undefined, trackIds: string[]) {
  const result = releaseHolder(holds, holder, trackIds);
  setOfflineHolds(result.holds);
  await eraseTracks(result.released);
}

async function eraseTracks(gone: string[]) {
  if (!gone.length) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(gone.map((id) => cache.delete(requestOf(id))));
  } catch {
    // Хранилище недоступно: из списка треки всё равно уходят
  }
  gone.forEach((id) => {
    const url = objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  });
  const state = getOfflineState();
  publish({ entries: state.entries.filter((entry) => !gone.includes(entry.track.id)), problem: undefined });
}
