import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  addTracksToShared, canEditTracks, getSharedDetails, getSharedPlaylists, refreshSharedPlaylists, toTrackInput,
} from './shared/musicShared';
import { addTracksToPlaylist, getPlaylists, refreshPlaylists } from './musicPlaylists';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicPlaylistChips.module.scss';

type OwnProps = {
  track: MusicTrack;
  // «Новый…» — прежний выбор с полем названия
  onNew: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

// «Добавить в плейлист» внизу шторки трека (доска `XpMusic`): чипы плейлистов, выделен тот, где трек уже есть
const MusicPlaylistChips = ({ track, onNew, onDone }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  // Общие плейлисты, где можно добавлять (MUSIC-3)
  const shared = useDerivedState(getSharedPlaylists).filter((playlist) => canEditTracks(playlist.myRole));
  const sharedDetails = useDerivedState(getSharedDetails);
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    void refreshPlaylists();
    void refreshSharedPlaylists();
  }, []);

  const handlePick = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const { playlist, shared: sharedId } = e.currentTarget.dataset;
    setIsAdding(true);
    try {
      if (sharedId) await addTracksToShared(sharedId, [toTrackInput(track)]);
      else await addTracksToPlaylist(playlist!, [track]);
    } finally {
      setIsAdding(false);
    }
    onDone();
  });

  return (
    <div className={styles.root} data-playlist-chips>
      <div className={styles.caption}>{lang('MusicPlaylistChipsTitle')}</div>
      <div className={styles.chips}>
        {playlists.map((playlist) => {
          const hasTrack = playlist.items.some((item) => item.trackId === track.id);
          return (
            <button
              key={playlist.id}
              type="button"
              className={buildClassName(kit.chip, hasTrack && kit.chipOn)}
              aria-pressed={hasTrack}
              disabled={isAdding || hasTrack}
              data-playlist={playlist.id}
              onClick={handlePick}
            >
              {playlist.name}
            </button>
          );
        })}
        {shared.map((playlist) => {
          const hasTrack = Boolean(sharedDetails[playlist.id]?.items.some((item) => item.trackId === track.id));
          return (
            <button
              key={playlist.id}
              type="button"
              className={buildClassName(kit.chip, hasTrack && kit.chipOn)}
              aria-pressed={hasTrack}
              disabled={isAdding || hasTrack}
              data-shared={playlist.id}
              onClick={handlePick}
            >
              {playlist.name}
            </button>
          );
        })}
        <button type="button" className={kit.chip} disabled={isAdding} data-playlist-chip-new onClick={onNew}>
          {lang('MusicPlaylistChipNew')}
        </button>
      </div>
    </div>
  );
};

export default memo(MusicPlaylistChips);
