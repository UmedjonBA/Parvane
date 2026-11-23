import { useEffect, useState } from '../../../lib/teact/teact';

import type { MusicCatalogTrack, MusicTrack } from '../../../api/parvane/musicApi';

import { callMusic, getMusicInfo, loadMusicInfo } from '../music/musicPlayer';
import { PALETTE_GROUP_LIMIT, TEXT_MIN_QUERY_LENGTH } from './paletteSearch';

import useDerivedState from '../../../hooks/useDerivedState';

// Запрос к библиотеке сервера — не на каждое нажатие: после паузы в наборе
const MUSIC_SEARCH_DELAY_MS = 250;
const NO_TRACKS: MusicTrack[] = [];
const NO_CATALOG: MusicCatalogTrack[] = [];
// Треков каталога в общем поиске (доска `MusicChat-03`) — немного: подробнее — «В поиске музыки»
const CATALOG_LIMIT = 3;

// Parvane: треки «Музыки» для общего поиска — поиск библиотеки сервера (`music.library.search`). Пока «Музыка»
// выключена на устройстве либо не подключена на сервере, запросов нет. Ответ на прежний запрос не показывается
export default function usePaletteMusic(query: string, isOn: boolean) {
  const info = useDerivedState(getMusicInfo);
  const [found, setFound] = useState<{ query: string; tracks: MusicTrack[] }>();
  const [catalog, setCatalog] = useState<{ query: string; tracks: MusicCatalogTrack[] }>();
  const term = query.trim();
  const canSearch = isOn && term.length >= TEXT_MIN_QUERY_LENGTH;

  useEffect(() => {
    if (isOn && !getMusicInfo()) void loadMusicInfo().catch(() => undefined);
  }, [isOn]);

  const isEnabled = Boolean(info?.isEnabled);
  const isFetchEnabled = Boolean(info?.isFetchEnabled);
  useEffect(() => {
    if (!canSearch || !isEnabled) return undefined;
    let isCurrent = true;
    const timer = window.setTimeout(() => {
      callMusic('parvaneMusicSearch', { query: term })
        .then((page) => {
          if (isCurrent) setFound({ query: term, tracks: page.tracks.slice(0, PALETTE_GROUP_LIMIT) });
        })
        .catch(() => undefined);
      // Каталог — то, чего на сервере нет (доска `MusicChat-03`)
      if (isFetchEnabled) {
        callMusic('parvaneMusicCatalogSearch', { query: term })
          .then((page) => {
            const missing = page.tracks.filter((track) => !track.libraryTrackId).slice(0, CATALOG_LIMIT);
            if (isCurrent) setCatalog({ query: term, tracks: missing });
          })
          .catch(() => undefined);
      }
    }, MUSIC_SEARCH_DELAY_MS);
    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [canSearch, isEnabled, isFetchEnabled, term]);

  return {
    isMusicReady: isEnabled,
    tracks: canSearch && isEnabled && found?.query === term ? found.tracks : NO_TRACKS,
    catalogTracks: canSearch && isEnabled && catalog?.query === term ? catalog.tracks : NO_CATALOG,
  };
}
