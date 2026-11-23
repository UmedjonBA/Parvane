import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';
import {
  callMusic, dropTrackFromQueue, getMusicInfo, loadMusicInfo,
} from './musicPlayer';

// Parvane (spec 041, доска `ZdMusicX`): «Удалить из библиотеки сервера» — в меню любого трека, который добавил сам
// пользователь, а администратору — у любого добавленного. Свои добавленные треки помнятся здесь (id), удаление
// сообщает открытым спискам событием

export const MUSIC_LIBRARY_CHANGED_EVENT = 'parvane-music-library-changed';

const [getOwnAdded, setOwnAdded] = createSignal<Set<string>>(new Set());
// Сколько треков добавил сам — столько же, сколько строк в «Добавлено мной» (трек без id музыкального сервера
// там ещё не показывается)
const [getOwnAddedCount, setOwnAddedCount] = createSignal(0);

export { getOwnAdded, getOwnAddedCount };

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => {
    setOwnAdded(new Set());
    setOwnAddedCount(0);
  });
}

/** Перечитать свои добавленные (при открытии «Музыки» и после скачивания). */
export async function refreshOwnAdded() {
  if (!getMusicInfo()?.isFetchEnabled) return;
  const added = await callMusic('parvaneMusicAdded', { isMine: true }).catch(() => undefined);
  if (!added) return;
  const ids = added.map((item) => item.track.id).filter(Boolean);
  setOwnAdded(new Set(ids));
  setOwnAddedCount(ids.length);
}

// Музыкальный сервер пересканирует библиотеку за несколько секунд: экраны перечитываются сразу и ещё раз после этого
// (иначе альбом удалённого трека оставался в «Новом на сервере»)
const RESCAN_SETTLE_MS = 8000;

export function announceLibraryRescan() {
  window.dispatchEvent(new Event(MUSIC_LIBRARY_CHANGED_EVENT));
  window.setTimeout(() => window.dispatchEvent(new Event(MUSIC_LIBRARY_CHANGED_EVENT)), RESCAN_SETTLE_MS);
}

export function canDeleteTrack(trackId: string) {
  const info = getMusicInfo();
  return Boolean(info?.isFetchEnabled && (info.isAdmin || getOwnAdded().has(trackId)));
}

/** В корзину (на 30 дней); не вышло — `false`. */
export async function deleteLibraryTrack(trackId: string) {
  const isDone = await callMusic('parvaneMusicAddedDelete', { trackId }).then(() => true, () => false);
  if (!isDone) return false;
  const next = new Set(getOwnAdded());
  next.delete(trackId);
  setOwnAdded(next);
  setOwnAddedCount(Math.max(0, getOwnAddedCount() - 1));
  void loadMusicInfo();
  dropTrackFromQueue(trackId);
  announceLibraryRescan();
  return true;
}
