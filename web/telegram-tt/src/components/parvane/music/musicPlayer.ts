import type {
  createMusicApi, MusicInfo, MusicStreamQuality, MusicTrack,
} from '../../../api/parvane/musicApi';

import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import { engineStatic, loadProtocol } from '../../../api/parvane/v2/engine';
// Parvane (spec 039, 041): плеер «Музыки» — один на приложение: играет в любом модуле, им управляют экран
// «Музыки», мини-плеер на телефоне и виджет в боковой панели. Порядок воспроизведения (следующий трек,
// «вперемешку», повтор, правка очереди) считает движок (`musicQueue*`, правило MUSIC-1); здесь — элемент
// `<audio>`, ссылки на поток и память устройства (очередь, недавно прослушанное)
import { loadOfflineUrl } from './musicOffline';

type MusicMethods = ReturnType<typeof createMusicApi>;
export const callMusic = callApi as unknown as <N extends keyof MusicMethods>(
  name: N, ...args: Parameters<MusicMethods[N]>
) => ReturnType<MusicMethods[N]>;

export type MusicRepeat = 'off' | 'all' | 'one';

// Очередь, как её отдаёт движок (`Queue::view`)
export type MusicQueue = {
  tracks: string[];
  index: number;
  shuffle: boolean;
  repeat: MusicRepeat;
  order: number[];
  seed: number;
  currentId?: string;
  upcoming: string[];
};

export type MusicPlayerState = {
  queue: MusicQueue;
  // Сведения о треках очереди (сама очередь хранит только id)
  tracksById: Record<string, MusicTrack>;
  isPlaying: boolean;
  // Трек не удалось начать: нет связи, ссылка не выдана, файл не играется
  hasError: boolean;
};

const QUEUE_KEY = 'parvane:music-queue';
// Последние сведения о библиотеке сервера — для запуска без сети
const INFO_KEY = 'parvane:music-info';
const RECENT_KEY = 'parvane:music-recent';
const RECENT_LIMIT = 20;
// Ссылка на поток берётся заново за минуту до конца срока
const URL_MARGIN_MS = 60 * 1000;
// «Назад» в первые секунды трека — предыдущий трек, позже — начало этого
const RESTART_AFTER_SECS = 3;
const TRACKS_PER_REQUEST = 100;
const EMPTY_QUEUE: MusicQueue = {
  tracks: [], index: -1, shuffle: false, repeat: 'off', order: [], seed: 0, upcoming: [],
};

const [getMusicPlayer, setMusicPlayer] = createSignal<MusicPlayerState>({
  queue: EMPTY_QUEUE, tracksById: {}, isPlaying: false, hasError: false,
});
// Позиция — отдельным сигналом: меняется каждую секунду и не должна перерисовывать списки
const [getMusicPosition, setMusicPosition] = createSignal({ positionSecs: 0, durationSecs: 0 });
const [getMusicInfo, setMusicInfo] = createSignal<MusicInfo | undefined>(undefined);
const [getMusicRecent, setMusicRecent] = createSignal<MusicTrack[]>(readJson<MusicTrack[]>(RECENT_KEY) || []);

export {
  getMusicInfo, getMusicPlayer, getMusicPosition, getMusicRecent,
};

let audio: HTMLAudioElement | undefined;
let loadedTrackId: string | undefined;
let isRestored = false;
const streamUrls = new Map<string, { url: string; expiresMs: number }>();

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
    // Память устройства недоступна: очередь живёт до перезагрузки
  }
}

function parseQueue(json: string) {
  // eslint-disable-next-line no-null/no-null
  return JSON.parse(json, (_key, value: unknown) => (value === null ? undefined : value)) as MusicQueue;
}

/** Действие очереди в движке: вход — текущая очередь, выход — новая. */
function queueCall(name: string, args: Record<string, unknown> = {}) {
  const queue = engineStatic<MusicQueue>(name, { queue: getMusicPlayer().queue, ...args });
  return parseQueue(JSON.stringify(queue));
}

// Мобильная сеть либо режим экономии — перекодированный поток, иначе файл как есть
function pickQuality(): MusicStreamQuality {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  return connection?.saveData || connection?.type === 'cellular' ? 'opus' : 'original';
}

export function getCurrentTrack(state = getMusicPlayer()) {
  const { currentId } = state.queue;
  return currentId ? state.tracksById[currentId] : undefined;
}

/** Ссылка на обложку нужного размера; обложки у трека нет либо библиотека их не отдаёт — `undefined`. */
export function coverUrl(coverId: string | undefined, size: number) {
  const base = getMusicInfo()?.coverBase;
  return base && coverId ? `${base}/${encodeURIComponent(coverId)}?size=${size}` : undefined;
}

export async function loadMusicInfo() {
  // Запуск без сети: сервер не ответит — сведения берутся с устройства, чтобы открылось «Загруженное»;
  // сеть вернулась — спрашиваем сервер заново
  const saved = navigator.onLine ? undefined : readJson<MusicInfo>(INFO_KEY);
  if (saved) {
    setMusicInfo(saved);
    window.addEventListener('online', () => void loadMusicInfo(), { once: true });
    return saved;
  }
  const info = await callMusic('parvaneMusicInfo');
  if (info.isEnabled) writeJson(INFO_KEY, info);
  setMusicInfo(info);
  return info;
}

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('timeupdate', publishPosition);
  audio.addEventListener('durationchange', publishPosition);
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => applyQueue(queueCall('musicQueueNext', { auto: true }), true));
  audio.addEventListener('error', () => {
    if (loadedTrackId) setMusicPlayer({ ...getMusicPlayer(), isPlaying: false, hasError: true });
  });
  return audio;
}

function publishPosition() {
  if (!audio) return;
  const positionSecs = Math.floor(audio.currentTime) || 0;
  const durationSecs = Number.isFinite(audio.duration) ? Math.floor(audio.duration) : 0;
  const previous = getMusicPosition();
  if (previous.positionSecs !== positionSecs || previous.durationSecs !== durationSecs) {
    setMusicPosition({ positionSecs, durationSecs });
  }
}

function setPlaying(isPlaying: boolean) {
  const state = getMusicPlayer();
  if (state.isPlaying !== isPlaying) setMusicPlayer({ ...state, isPlaying });
}

function saveQueue(queue: MusicQueue) {
  const {
    tracks, index, shuffle, repeat, order, seed,
  } = queue;
  writeJson(QUEUE_KEY, {
    tracks, index, shuffle, repeat, order, seed,
  });
}

function rememberPlayed(track: MusicTrack) {
  const recent = [track, ...getMusicRecent().filter((item) => item.id !== track.id)].slice(0, RECENT_LIMIT);
  setMusicRecent(recent);
  writeJson(RECENT_KEY, recent);
}

async function streamUrlOf(trackId: string) {
  // Трек, сохранённый на устройстве, играет без сервера
  const offlineUrl = await loadOfflineUrl(trackId);
  if (offlineUrl) return offlineUrl;
  const cached = streamUrls.get(trackId);
  if (cached && cached.expiresMs - URL_MARGIN_MS > Date.now()) return cached.url;
  const reply = await callMusic('parvaneMusicStreamUrl', { trackId, quality: pickQuality() });
  if (!reply.url) throw new Error('no stream url');
  streamUrls.set(trackId, { url: reply.url, expiresMs: reply.expiresMs });
  return reply.url;
}

async function loadCurrent(shouldPlay: boolean) {
  const player = ensureAudio();
  const track = getCurrentTrack();
  if (!track) {
    player.pause();
    player.removeAttribute('src');
    loadedTrackId = undefined;
    setMusicPosition({ positionSecs: 0, durationSecs: 0 });
    setPlaying(false);
    return;
  }
  if (loadedTrackId !== track.id) {
    loadedTrackId = track.id;
    setMusicPosition({ positionSecs: 0, durationSecs: track.durationSecs });
    try {
      const url = await streamUrlOf(track.id);
      // Пока шёл запрос ссылки, выбрали другой трек
      if (loadedTrackId !== track.id) return;
      player.src = url;
    } catch {
      setMusicPlayer({ ...getMusicPlayer(), isPlaying: false, hasError: true });
      return;
    }
    updateMediaSession(track);
  }
  if (!shouldPlay) return;
  rememberPlayed(track);
  await player.play().catch(() => setPlaying(false));
}

function applyQueue(queue: MusicQueue, shouldPlay: boolean, extraTracks: MusicTrack[] = []) {
  const state = getMusicPlayer();
  const tracksById = { ...state.tracksById };
  extraTracks.forEach((track) => {
    tracksById[track.id] = track;
  });
  // Сведения о треках, которых в очереди больше нет, не копятся
  Object.keys(tracksById).forEach((id) => {
    if (!queue.tracks.includes(id)) delete tracksById[id];
  });
  setMusicPlayer({
    queue, tracksById, isPlaying: state.isPlaying, hasError: false,
  });
  saveQueue(queue);
  void loadCurrent(shouldPlay);
}

/** Играть список с этого трека: очередь заменяется. */
export function playTracks(tracks: MusicTrack[], startIndex = 0) {
  if (!tracks.length) return;
  const queue = queueCall('musicQueueStart', {
    tracks: tracks.map((track) => track.id), start: startIndex, seed: Date.now(),
  });
  applyQueue(queue, true, tracks);
}

/** Добавить в очередь: следующим после играющего либо в конец. Пустая очередь начинает играть. */
export function addToQueue(tracks: MusicTrack[], isNext: boolean) {
  const wasEmpty = !getMusicPlayer().queue.tracks.length;
  applyQueue(queueCall('musicQueueAdd', { tracks: tracks.map((track) => track.id), next: isNext }), wasEmpty, tracks);
}

export function togglePlay() {
  const player = ensureAudio();
  if (!getCurrentTrack()) {
    // Очередь доиграна: «играть» начинает её заново
    if (getMusicPlayer().queue.tracks.length) applyQueue(queueCall('musicQueueNext', { auto: false }), true);
    return;
  }
  if (player.paused) void loadCurrent(true);
  else player.pause();
}

export function playNext() {
  applyQueue(queueCall('musicQueueNext', { auto: false }), true);
}

export function playPrevious() {
  if (audio && audio.currentTime > RESTART_AFTER_SECS) {
    audio.currentTime = 0;
    return;
  }
  applyQueue(queueCall('musicQueuePrev'), true);
}

/** Перейти к треку очереди по его месту в порядке проигрывания. */
export function playQueueItem(position: number) {
  applyQueue(queueCall('musicQueueJump', { position }), true);
}

export function removeQueueItem(position: number) {
  applyQueue(queueCall('musicQueueRemove', { position }), getMusicPlayer().isPlaying);
}

export function moveQueueItem(from: number, to: number) {
  applyQueue(queueCall('musicQueueMove', { from, to }), false);
}

export function clearQueue() {
  applyQueue(queueCall('musicQueueClear'), false);
}

export function toggleShuffle() {
  applyQueue(queueCall('musicQueueShuffle', { on: !getMusicPlayer().queue.shuffle, seed: Date.now() }), false);
}

export function cycleRepeat() {
  applyQueue(queueCall('musicQueueRepeat'), false);
}

export function seekTo(positionSecs: number) {
  if (!audio || !getCurrentTrack()) return;
  audio.currentTime = Math.max(0, positionSecs);
  publishPosition();
}

/** Отметка «любимое»: сразу на экране, затем на сервере; отказ сервера возвращает прежнее. */
export async function setTrackStarred(track: MusicTrack, isStarred: boolean) {
  const patch = (value: boolean) => {
    const state = getMusicPlayer();
    if (state.tracksById[track.id]) {
      setMusicPlayer({ ...state, tracksById: { ...state.tracksById, [track.id]: { ...track, isStarred: value } } });
    }
  };
  patch(isStarred);
  try {
    await callMusic('parvaneMusicStar', { trackId: track.id, isStarred });
    return true;
  } catch {
    patch(!isStarred);
    return false;
  }
}

function updateMediaSession(track: MusicTrack) {
  if (!('mediaSession' in navigator)) return;
  const cover = coverUrl(track.coverId, 512);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', playNext);
  navigator.mediaSession.setActionHandler('previoustrack', playPrevious);
}

/** Вернуть очередь прошлого запуска: на паузе, с того же трека. Сведения о треках берутся с сервера. */
export async function restoreMusicQueue() {
  if (isRestored) return;
  isRestored = true;
  const saved = readJson<unknown>(QUEUE_KEY);
  if (!saved) return;
  await loadProtocol();
  const queue = parseQueue(JSON.stringify(engineStatic<MusicQueue>('musicQueueView', { queue: saved })));
  if (!queue.tracks.length || getMusicPlayer().queue.tracks.length) return;
  const tracks: MusicTrack[] = [];
  for (let offset = 0; offset < queue.tracks.length; offset += TRACKS_PER_REQUEST) {
    const part = await callMusic('parvaneMusicTracks', {
      trackIds: queue.tracks.slice(offset, offset + TRACKS_PER_REQUEST),
    }).catch(() => []);
    part.forEach((track) => track && tracks.push(track));
  }
  // Очередь могли начать, пока шли запросы
  if (!tracks.length || getMusicPlayer().queue.tracks.length) return;
  if (tracks.length === queue.tracks.length) {
    applyQueue(queue, false, tracks);
    return;
  }
  // Часть треков с сервера убрали: очередь собирается заново из оставшихся, в прежнем порядке
  const known = tracks.map((track) => track.id);
  const rebuilt = engineStatic<MusicQueue>('musicQueueStart', {
    queue: saved, tracks: queue.upcoming.filter((id) => known.includes(id)), start: 0, shuffle: false,
  });
  applyQueue(parseQueue(JSON.stringify(rebuilt)), false, tracks);
}
