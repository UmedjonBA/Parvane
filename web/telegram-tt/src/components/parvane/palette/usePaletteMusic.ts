import { useEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import { callMusic, getMusicInfo, loadMusicInfo } from '../music/musicPlayer';
import { PALETTE_GROUP_LIMIT, TEXT_MIN_QUERY_LENGTH } from './paletteSearch';

import useDerivedState from '../../../hooks/useDerivedState';

// Запрос к библиотеке сервера — не на каждое нажатие: после паузы в наборе
const MUSIC_SEARCH_DELAY_MS = 250;
const NO_TRACKS: MusicTrack[] = [];

// Parvane: треки «Музыки» для общего поиска — поиск библиотеки сервера (`music.library.search`). Пока «Музыка»
// выключена на устройстве либо не подключена на сервере, запросов нет. Ответ на прежний запрос не показывается
export default function usePaletteMusic(query: string, isOn: boolean) {
  const info = useDerivedState(getMusicInfo);
  const [found, setFound] = useState<{ query: string; tracks: MusicTrack[] }>();
  const term = query.trim();
  const canSearch = isOn && term.length >= TEXT_MIN_QUERY_LENGTH;

  useEffect(() => {
    if (isOn && !getMusicInfo()) void loadMusicInfo().catch(() => undefined);
  }, [isOn]);

  const isEnabled = Boolean(info?.isEnabled);
  useEffect(() => {
    if (!canSearch || !isEnabled) return undefined;
    let isCurrent = true;
    const timer = window.setTimeout(() => {
      callMusic('parvaneMusicSearch', { query: term })
        .then((page) => {
          if (isCurrent) setFound({ query: term, tracks: page.tracks.slice(0, PALETTE_GROUP_LIMIT) });
        })
        .catch(() => undefined);
    }, MUSIC_SEARCH_DELAY_MS);
    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [canSearch, isEnabled, term]);

  return {
    isMusicReady: isEnabled,
    tracks: canSearch && isEnabled && found?.query === term ? found.tracks : NO_TRACKS,
  };
}
