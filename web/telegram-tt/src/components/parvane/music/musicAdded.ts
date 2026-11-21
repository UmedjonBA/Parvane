import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';
import { callMusic, getMusicInfo, loadMusicInfo } from './musicPlayer';

// Parvane (spec 041, доска `ZdMusicX`): «Удалить из библиотеки сервера» — в меню любого трека, который добавил сам
// пользователь, а администратору — у любого добавленного. Свои добавленные треки помнятся здесь (id), удаление
// сообщает открытым спискам событием

export const MUSIC_LIBRARY_CHANGED_EVENT = 'parvane-music-library-changed';

const [getOwnAdded, setOwnAdded] = createSignal<Set<string>>(new Set());

export { getOwnAdded };

if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_WIPED_EVENT, () => setOwnAdded(new Set()));

/** Перечитать свои добавленные (при открытии «Музыки» и после скачивания). */
export async function refreshOwnAdded() {
  if (!getMusicInfo()?.isFetchEnabled) return;
  const added = await callMusic('parvaneMusicAdded', { isMine: true }).catch(() => undefined);
  if (added) setOwnAdded(new Set(added.map((item) => item.track.id).filter(Boolean)));
}

export function canDeleteTrack(trackId: string) {
  const info = getMusicInfo();
  return Boolean(info?.isFetchEnabled && (info.isAdmin || getOwnAdded().has(trackId)));
}

export async function deleteLibraryTrack(trackId: string) {
  await callMusic('parvaneMusicAddedDelete', { trackId }).catch(() => undefined);
  const next = new Set(getOwnAdded());
  next.delete(trackId);
  setOwnAdded(next);
  void loadMusicInfo();
  window.dispatchEvent(new Event(MUSIC_LIBRARY_CHANGED_EVENT));
}
