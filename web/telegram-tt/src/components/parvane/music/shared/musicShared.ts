import { getGlobal } from '../../../../global';

import type { MusicPlaylist, MusicTrack } from '../../../../api/parvane/musicApi';
import type {
  createMusicSharedApi,
  MusicSharedAccess, MusicSharedDetails, MusicSharedItem, MusicSharedPlaylist, MusicSharedRole, MusicSharedTrackInput,
} from '../../../../api/parvane/musicSharedApi';

import { ACCOUNT_WIPED_EVENT } from '../../../../util/parvaneEvents';
import { createSignal } from '../../../../util/signals';
import { callApi } from '../../../../api/gramjs';
import {
  actOnPlaylists, addTracksToPlaylist, getPlaylistsStatus, refreshPlaylists,
} from '../musicPlaylists';
import { goToMusicView } from '../musicView';

// Parvane (spec 041, MUSIC-3): общие плейлисты на экране — список (свои и открытые всем на сервере), открытый
// плейлист с треками и участниками, действия. Плейлист хранит сервер и проверяет права; экран перечитывает его
// раз в `POLL_MS`, пока на него смотрят (живых событий у общих плейлистов нет)

type SharedMethods = ReturnType<typeof createMusicSharedApi>;
// Методы Parvane: типы `callApi` описывают только методы Telegram
const callShared = callApi as unknown as <N extends keyof SharedMethods>(
  name: N, ...args: Parameters<SharedMethods[N]>
) => ReturnType<SharedMethods[N]>;

// «Кто видит» на экране: «Только я» — личный плейлист контейнера `music.v1`
export type MusicPlaylistAccess = 'me' | MusicSharedAccess;

// Метод Parvane: типы `callApi` описывают только методы Telegram
const callNotice = callApi as unknown as (name: 'parvaneSendMusicNotice', args: {
  chatId: string; playlistId: string; name: string; trackTitle: string;
}) => Promise<boolean | undefined>;
const POLL_MS = 10000;
// Контейнер личных плейлистов подключается при первом обращении: ждём готовности перед переносом треков
const READY_WAIT_MS = 500;
const READY_ATTEMPTS = 20;

const [getSharedPlaylists, setSharedPlaylists] = createSignal<MusicSharedPlaylist[]>([]);
// Открытые всем на сервере, где я не участник
const [getServerPlaylists, setServerPlaylists] = createSignal<MusicSharedPlaylist[]>([]);
const [getSharedDetails, setSharedDetails] = createSignal<Record<string, MusicSharedDetails>>({});
const [getIsSharedFailed, setIsSharedFailed] = createSignal(false);

export {
  getIsSharedFailed, getServerPlaylists, getSharedDetails, getSharedPlaylists,
};

let watchers = 0;
let pollTimer: number | undefined;
const watchedIds = new Map<string, number>();

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => {
    setSharedPlaylists([]);
    setServerPlaylists([]);
    setSharedDetails({});
  });
}

/** Список общих плейлистов: свои (участник) и открытые всем на сервере. */
export async function refreshSharedPlaylists() {
  try {
    const [mine, open] = await Promise.all([
      callShared('parvaneMusicSharedList', {}),
      callShared('parvaneMusicSharedList', { isServerWide: true }),
    ]);
    setSharedPlaylists(mine);
    setServerPlaylists(open.filter((playlist) => playlist.myRole === 'none'));
    setIsSharedFailed(false);
  } catch {
    setIsSharedFailed(true);
  }
}

/** Плейлист с треками и участниками; неизменённый (та же версия) не перечитывается. `false` — не найден. */
export async function loadSharedPlaylist(id: string) {
  const known = getSharedDetails()[id];
  try {
    const details = await callShared('parvaneMusicSharedGet', { id, ifVersion: known?.playlist.version });
    if (details) setSharedDetails({ ...getSharedDetails(), [id]: details });
    return true;
  } catch (err) {
    if (String(err).includes('NOT_FOUND')) {
      forgetShared(id);
      return false;
    }
    return Boolean(known);
  }
}

function forgetShared(id: string) {
  const { [id]: removed, ...rest } = getSharedDetails();
  setSharedDetails(rest);
  setSharedPlaylists(getSharedPlaylists().filter((playlist) => playlist.id !== id));
}

/** Пока на общие плейлисты смотрят — перечитывать; вернёт отписку. `id` — открытый плейлист. */
export function watchSharedPlaylists(id?: string) {
  watchers++;
  if (id) watchedIds.set(id, (watchedIds.get(id) || 0) + 1);
  if (watchers === 1) schedulePoll(true);
  else if (id) void loadSharedPlaylist(id);
  return () => {
    watchers--;
    if (id) {
      const left = (watchedIds.get(id) || 1) - 1;
      if (left) watchedIds.set(id, left);
      else watchedIds.delete(id);
    }
    if (!watchers) window.clearTimeout(pollTimer);
  };
}

function schedulePoll(isNow?: boolean) {
  window.clearTimeout(pollTimer);
  const run = async () => {
    await refreshSharedPlaylists();
    await Promise.all([...watchedIds.keys()].map((id) => loadSharedPlaylist(id)));
    if (watchers) pollTimer = window.setTimeout(run, POLL_MS);
  };
  if (isNow) void run();
  else pollTimer = window.setTimeout(run, POLL_MS);
}

/** Трек общего плейлиста для строки и плеера: сведения — подписи на момент добавления. */
export function toMusicTrack(item: MusicSharedItem): MusicTrack {
  return {
    id: item.trackId,
    title: item.title,
    artist: item.artist,
    album: '',
    albumId: '',
    artistId: '',
    durationSecs: item.durationSecs,
    coverId: '',
    trackNo: 0,
    year: 0,
    isStarred: false,
  };
}

export function toTrackInput(
  track: Pick<MusicTrack, 'id' | 'title' | 'artist' | 'durationSecs'>,
): MusicSharedTrackInput {
  return {
    trackId: track.id, title: track.title, artist: track.artist, durationSecs: track.durationSecs,
  };
}

export function canEditTracks(role: MusicSharedRole) {
  return role === 'owner' || role === 'editor';
}

async function afterChange(id: string, playlist?: MusicSharedPlaylist) {
  if (playlist) {
    setSharedPlaylists([playlist, ...getSharedPlaylists().filter((item) => item.id !== playlist.id)]);
  }
  await loadSharedPlaylist(id);
}

/** Новый общий плейлист (с треками — «Сделать общим»). `undefined` — не создан. */
export async function createSharedPlaylist(
  name: string, access: MusicSharedAccess, tracks: MusicSharedTrackInput[] = [],
) {
  const playlist = await callShared('parvaneMusicSharedCreate', { name, access, tracks }).catch(() => undefined);
  if (playlist) await afterChange(playlist.id, playlist);
  return playlist;
}

export async function editSharedPlaylist(
  id: string, edit: { name?: string; access?: MusicSharedAccess; isIssueJoinKey?: boolean; isRotateJoinKey?: boolean },
) {
  const playlist = await callShared('parvaneMusicSharedEdit', { id, ...edit }).catch(() => undefined);
  if (playlist) await afterChange(id, playlist);
  return playlist;
}

export async function deleteSharedPlaylist(id: string) {
  const isDone = await callShared('parvaneMusicSharedDelete', { id }).catch(() => false);
  if (isDone) forgetShared(id);
  return isDone;
}

export async function leaveSharedPlaylist(id: string) {
  const isDone = await callShared('parvaneMusicSharedLeave', { id }).catch(() => false);
  if (isDone) forgetShared(id);
  return isDone;
}

/** Добавить треки; ответ — сколько пропущено как повторы, `undefined` — не вышло. */
export async function addTracksToShared(id: string, tracks: MusicSharedTrackInput[]) {
  const reply = await callShared('parvaneMusicSharedItems', { id, add: tracks }).catch(() => undefined);
  if (!reply) return undefined;
  await afterChange(id, reply.playlist);
  if (tracks.length > (reply.skipped || 0)) noticeGroups(id, reply.playlist?.name || '', tracks[0].title);
  return reply.skipped;
}

// MUSIC-NOTICE-1 (доска `MusicChat-01`): плейлист привязан к группе — в её чат строка «… добавил «трек» в плейлист
// группы». Привязка известна по сведениям групп, которые устройство уже читало
function noticeGroups(playlistId: string, name: string, trackTitle: string) {
  const global = getGlobal();
  Object.entries(global.chats.fullInfoById).forEach(([chatId, info]) => {
    if (info?.parvaneShared?.playlistId !== playlistId) return;
    void callNotice('parvaneSendMusicNotice', {
      chatId, playlistId, name, trackTitle,
    }).catch(() => undefined);
  });
}

export async function removeSharedItem(id: string, itemId: string) {
  const reply = await callShared('parvaneMusicSharedItems', { id, remove: [itemId] }).catch(() => undefined);
  if (reply) await afterChange(id, reply.playlist);
  return Boolean(reply);
}

/** Переставить запись на место `to` (номер в списке после перестановки). */
export async function moveSharedItem(id: string, from: number, to: number) {
  const items = getSharedDetails()[id]?.items || [];
  const moving = items[from];
  if (!moving || from === to) return false;
  const rest = items.filter((item) => item.id !== moving.id);
  const before = rest[to]?.id || '';
  const reply = await callShared('parvaneMusicSharedItems', { id, moveId: moving.id, moveBeforeId: before })
    .catch(() => undefined);
  if (reply) await afterChange(id, reply.playlist);
  return Boolean(reply);
}

/** Позвать по нику; `'unknown'` — такого пользователя нет, `undefined` — не вышло. */
export async function inviteToShared(id: string, nick: string, role: 'editor' | 'listener') {
  const reply = await callShared('parvaneMusicSharedMember', { id, nick, role }).catch(() => undefined);
  if (reply && reply !== 'unknown') await afterChange(id, reply);
  return reply;
}

export async function setSharedMemberRole(id: string, address: string, role: 'editor' | 'listener') {
  const reply = await callShared('parvaneMusicSharedMember', { id, address, role }).catch(() => undefined);
  if (reply && reply !== 'unknown') await afterChange(id, reply);
  return Boolean(reply);
}

export async function removeSharedMember(id: string, address: string) {
  const reply = await callShared('parvaneMusicSharedMember', { id, address, isRemove: true }).catch(() => undefined);
  if (reply && reply !== 'unknown') await afterChange(id, reply);
  return Boolean(reply);
}

/** Вступить по ключу из карточки в чате. `undefined` — ключ не подошёл либо плейлиста нет. */
export async function joinSharedPlaylist(id: string, joinKey: string) {
  const playlist = await callShared('parvaneMusicSharedJoin', { id, joinKey }).catch(() => undefined);
  if (playlist) await afterChange(id, playlist);
  return playlist;
}

/** Плейлист группы (сведения группы, шапка чата): вступить по ключу из журнала группы, если ещё не участник, и
 * открыть в «Музыке»; не вышло — `false`. */
export async function openGroupPlaylist(id: string, joinKey: string) {
  const isMember = getSharedPlaylists().some((playlist) => playlist.id === id);
  const joined = isMember ? { id } : await joinSharedPlaylist(id, joinKey);
  if (joined) goToMusicView({ kind: 'shared', id: joined.id });
  return Boolean(joined);
}

/** Ключ вступления для карточки в чате: у владельца выдаётся при первой отправке. */
export async function ensureJoinKey(id: string) {
  const known = getSharedDetails()[id]?.playlist;
  if (known?.joinKey) return known.joinKey;
  const playlist = await editSharedPlaylist(id, { isIssueJoinKey: true });
  return playlist?.joinKey;
}

/** «Сделать общим»: общий плейлист с теми же треками по порядку, личный удаляется. */
export async function makePlaylistShared(personal: MusicPlaylist, access: MusicSharedAccess) {
  const tracks = personal.items.map((item) => ({
    trackId: item.trackId, title: item.title, artist: item.artist, durationSecs: item.durationSecs,
  }));
  const shared = await createSharedPlaylist(personal.name, access, tracks);
  if (shared) await actOnPlaylists({ action: 'delete', playlistId: personal.id });
  return shared;
}

/** «Сделать личным» (только владелец): личный плейлист с теми же треками, общий удаляется у всех. */
export async function makePlaylistPersonal(id: string) {
  const details = getSharedDetails()[id];
  if (!details || details.playlist.myRole !== 'owner' || !await waitPersonalReady()) return undefined;
  const created = await actOnPlaylists({ action: 'create', name: details.playlist.name });
  if (!created?.id) return undefined;
  if (details.items.length) await addTracksToPlaylist(created.id, details.items.map(toMusicTrack));
  await deleteSharedPlaylist(id);
  return created.id;
}

/** Знак участника: «Kora Mesh» → «KM», «lampa@server» → «L». */
export function initialsOf(name: string) {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';
}

async function waitPersonalReady() {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    await refreshPlaylists();
    const status = getPlaylistsStatus();
    if (status === 'ready') return true;
    if (status !== 'loading') return false;
    await new Promise((resolve) => {
      setTimeout(resolve, READY_WAIT_MS);
    });
  }
  return false;
}
