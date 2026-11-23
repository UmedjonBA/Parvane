import type { MusicTrack } from '../../../api/parvane/musicApi';

import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { setParvaneSection } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';

// Parvane (spec 041, доски `MusicHome`, `MusicLibrary`, `DeskMusic`): что открыто в «Музыке». Экран один на
// приложение, переходы идут и извне (меню трека в плеере, «+» модуля), поэтому вид — сигнал с историей «назад».
// Телефон: вкладки «Главная / Поиск / Библиотека», остальное — страницы поверх вкладки со своей шапкой

export type MusicTab = 'home' | 'search' | 'library';

export type MusicView =
  | {
    kind: MusicTab | 'starred' | 'artists' | 'albums' | 'offline' | 'added' | 'playlists' | 'uploads'
      | 'mix' | 'mixArtists' | 'queue' | 'dislikes' | 'trash';
  }
  | { kind: 'playlist' | 'album' | 'artist' | 'singles' | 'shared' | 'catalogArtist' | 'catalogAlbum'; id: string };

export type MusicViewKind = MusicView['kind'];

// «+» модуля (доска `MusicHome`): «Найти в каталоге» (поиск с курсором в поле), «Вставить ссылку», «Загрузить
// файл», «Новый плейлист»
export type MusicAddRequest = 'fetch' | 'link' | 'file' | 'playlist';

const HOME: MusicView = { kind: 'home' };

const [getMusicView, setMusicView] = createSignal<MusicView>(HOME);
const [getMusicAddRequest, setMusicAddRequest] = createSignal<MusicAddRequest | undefined>(undefined);
// Окно «Новый плейлист»: открыто и для какого трека («Сразу добавить …»)
const [getNewPlaylist, setNewPlaylist] = createSignal<{ track?: MusicTrack } | undefined>(undefined);
// Строка поиска по библиотеке: одна на «Главную» (компьютер) и вкладку «Поиск»
const [getMusicQuery, setMusicQuery] = createSignal('');
// «+ → Вставить ссылку / Загрузить файл»: что открыть на странице «Загрузки на сервер» (номер — каждый раз новый)
type UploadsIntent = { kind: 'link' | 'file'; token: number };
const [getUploadsIntent, setUploadsIntent] = createSignal<UploadsIntent | undefined>(undefined);

export {
  getMusicAddRequest, getMusicQuery, getMusicView, getNewPlaylist, getUploadsIntent, setMusicQuery,
};

/** Открыть «Загрузки на сервер» со шторкой «Вставить ссылку» либо выбором файлов. */
export function openUploadsWith(kind: 'link' | 'file') {
  setUploadsIntent({ kind, token: Date.now() });
  openMusicView({ kind: 'uploads' });
}

let history: MusicView[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => {
    history = [];
    setMusicView(HOME);
    setNewPlaylist(undefined);
    setMusicQuery('');
  });
}

/** Вкладка телефона, к которой относится вид: главная и поиск — свои, остальное — «Библиотека». */
export function getMusicTab(view: MusicView): MusicTab {
  if (view.kind === 'home' || view.kind === 'search') return view.kind;
  // «Микс дня» и выбор исполнителей для него открываются с «Главной»
  if (view.kind === 'mix' || view.kind === 'mixArtists') return 'home';
  // «Загрузки на сервер» открываются из «Поиска» (доска `ZpMusicX`)
  if (view.kind === 'uploads') return 'search';
  return 'library';
}

/** Телефон: вид — страница поверх вкладки (своя шапка с «назад», без ленты модулей). */
export function getIsMusicPage(view: MusicView) {
  return view.kind !== 'home' && view.kind !== 'search' && view.kind !== 'library';
}

/** Открыть вид: `isRoot` — раздел навигации (история сбрасывается), иначе переход вглубь с возвратом «назад». */
export function openMusicView(view: MusicView, isRoot?: boolean) {
  const current = getMusicView();
  if (isRoot) history = [];
  else if (current.kind !== view.kind || ('id' in current && 'id' in view && current.id !== view.id)) {
    history.push(current);
  }
  setMusicView(view);
}

/** «Назад» страницы: предыдущий вид; истории нет — вкладка, к которой относится страница. */
export function goBackMusic() {
  const previous = history.pop();
  setMusicView(previous || { kind: getMusicTab(getMusicView()) });
}

/** Переход в «Музыку» извне (меню трека в плеере, карточка в чате). */
export function goToMusicView(view: MusicView) {
  setParvaneSection('music');
  openMusicView(view);
}

export function requestMusicAdd(request: MusicAddRequest) {
  setParvaneSection('music');
  setMusicAddRequest(request);
}

export function consumeMusicAddRequest() {
  setMusicAddRequest(undefined);
}

export function openNewPlaylist(track?: MusicTrack) {
  setNewPlaylist({ track });
}

export function closeNewPlaylist() {
  setNewPlaylist(undefined);
}
