import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { OfflineHolds } from './musicOfflineHolds';

import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';
import {
  addHolds, dropHolds, EMPTY_HOLDS,
} from './musicOfflineHolds';
import { callMusic } from './musicPlayer';

// Parvane (spec 039, 041 C3): «Загруженное» — треки, сохранённые на устройстве для игры без сети. Файл трека
// лежит в хранилище браузера (Cache Storage), список — рядом; плеер сначала ищет трек здесь. Треки общей
// библиотеки сервер и так видит, поэтому файлы хранятся как есть, без шифрования

export type OfflineEntry = {
  track: MusicTrack;
  bytes: number;
  savedMs: number;
};

export type OfflineState = {
  entries: OfflineEntry[];
  // Очередь скачивания: сколько треков осталось вместе с текущим и сколько было в начале
  pending: number;
  total: number;
  problem?: 'limit' | 'failed';
};

const CACHE_NAME = 'parvane-music-offline';
const INDEX_KEY = 'parvane:music-offline';
// Почему треки на устройстве: загруженные плейлисты и их состав (`musicOfflineHolds.ts`)
const HOLDS_KEY = 'parvane:music-offline-holds';
// Сколько места на устройстве отдано под загруженное
export const OFFLINE_LIMIT_BYTES = 1024 * 1024 * 1024;

const [getOfflineState, setOfflineState] = createSignal<OfflineState>({ entries: readIndex(), pending: 0, total: 0 });

export { getOfflineState };

const queue: MusicTrack[] = [];
const objectUrls = new Map<string, string>();
let isRunning = false;
// Трек, который качается сейчас (из очереди он уже взят)
let currentId: string | undefined;
let holds = readHolds();

// Выход из аккаунта: файлы стёрты вместе с кэшем (`deviceWipe.ts`), в памяти вкладки их списка тоже нет
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_WIPED_EVENT, forgetOffline);

function forgetOffline() {
  holds = EMPTY_HOLDS;
  queue.length = 0;
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
  setOfflineState({ entries: [], pending: 0, total: 0 });
}

function readHolds(): OfflineHolds {
  try {
    const saved = localStorage.getItem(HOLDS_KEY);
    return saved ? JSON.parse(saved) as OfflineHolds : EMPTY_HOLDS;
  } catch {
    return EMPTY_HOLDS;
  }
}

export function getOfflineHolds() {
  return holds;
}

export function setOfflineHolds(next: OfflineHolds) {
  holds = next;
  try {
    localStorage.setItem(HOLDS_KEY, JSON.stringify(next));
  } catch {
    // Память устройства недоступна: загруженные плейлисты сверяются до перезагрузки
  }
}

function readIndex(): OfflineEntry[] {
  try {
    const saved = localStorage.getItem(INDEX_KEY);
    return saved ? JSON.parse(saved) as OfflineEntry[] : [];
  } catch {
    return [];
  }
}

function publish(change: Partial<OfflineState>) {
  const next = { ...getOfflineState(), ...change };
  setOfflineState(next);
  if (!change.entries) return;
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(next.entries));
  } catch {
    // Память устройства недоступна: список живёт до перезагрузки
  }
}

function requestOf(trackId: string) {
  return new Request(`/__parvane-music-offline/${encodeURIComponent(trackId)}`);
}

export function isTrackOffline(trackId: string) {
  return getOfflineState().entries.some((entry) => entry.track.id === trackId);
}

/** Трек ждёт загрузки либо качается сейчас. */
export function isTrackSaving(trackId: string) {
  return currentId === trackId || queue.some((item) => item.id === trackId);
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

/** Сохранить треки на устройстве: уже сохранённые и стоящие в очереди пропускаются. `playlistId` — загружается
 * плейлист целиком (`tracks` — весь его состав): дальше он следует за составом (`musicOfflineSync.ts`). */
export function saveTracksOffline(tracks: MusicTrack[], playlistId?: string) {
  setOfflineHolds(addHolds(holds, tracks.map((track) => track.id), playlistId));
  queueOfflineTracks(tracks);
}

/** Докачать треки, отметки которых уже стоят (сверка загруженного плейлиста). */
export function queueOfflineTracks(tracks: MusicTrack[]) {
  const fresh = tracks.filter((track) => !isTrackOffline(track.id) && !queue.some((item) => item.id === track.id));
  if (!fresh.length) return;
  queue.push(...fresh);
  const state = getOfflineState();
  publish({ pending: queue.length + (isRunning ? 1 : 0), total: state.total + fresh.length, problem: undefined });
  if (!isRunning) void runQueue();
}

async function runQueue() {
  isRunning = true;
  while (queue.length) {
    const track = queue.shift()!;
    currentId = track.id;
    const outcome = await saveOne(track);
    currentId = undefined;
    if (outcome !== 'saved') {
      // Места нет либо сервер недоступен: остальное не качается, пока человек не попросит снова
      queue.length = 0;
      publish({ pending: 0, total: 0, problem: outcome });
      isRunning = false;
      return;
    }
    publish({ pending: queue.length });
  }
  isRunning = false;
  publish({ pending: 0, total: 0 });
}

async function saveOne(track: MusicTrack): Promise<'saved' | 'limit' | 'failed'> {
  try {
    const link = await callMusic('parvaneMusicStreamUrl', { trackId: track.id, quality: 'original' });
    const response = await fetch(link.url);
    if (!response.ok) return 'failed';
    const blob = await response.blob();
    if (getOfflineBytes() + blob.size > OFFLINE_LIMIT_BYTES) return 'limit';
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
  const state = getOfflineState();
  const gone = trackIds || state.entries.map((entry) => entry.track.id);
  setOfflineHolds(dropHolds(holds, trackIds));
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
  publish({ entries: state.entries.filter((entry) => !gone.includes(entry.track.id)), problem: undefined });
}
