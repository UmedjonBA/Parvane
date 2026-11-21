import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { OfflineHolder } from './musicOfflineHolds';

import buildClassName from '../../../util/buildClassName';
import { getOfflineHolds, getOfflineState, removeOfflineGroup, saveTracksOffline } from './musicOffline';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  tracks: MusicTrack[];
  holder: OfflineHolder;
};

// Parvane (spec 041, доски `MusicPlaylist`, `RpMusicA`): круглая кнопка «на устройство» у плейлиста и альбома —
// состояние «нет / идёт N из M / загружено»; повторное нажатие на загруженном убирает его с устройства
const MusicOfflineCircle = ({ tracks, holder }: OwnProps) => {
  const lang = useLang();
  const offline = useDerivedState(getOfflineState);
  const ids = tracks.map((track) => track.id);
  const saved = ids.filter((id) => offline.entries.some((entry) => entry.track.id === id)).length;
  const holds = getOfflineHolds();
  const isHeld = Boolean(holder.kind === 'playlist' ? holds.playlists[holder.id] : holds.albums[holder.id]);
  const isDone = isHeld && saved === ids.length;
  const isSaving = isHeld && !isDone && offline.pending > 0;

  const handleClick = useLastCallback(() => {
    if (isHeld) void removeOfflineGroup(holder, ids);
    else saveTracksOffline(tracks, holder);
  });

  const label = isDone || isSaving
    ? lang('MusicOfflineCircleDone', { done: saved, total: ids.length })
    : lang(holder.kind === 'album' ? 'MusicOfflineSaveAlbum' : 'MusicOfflineSavePlaylist');

  return (
    <button
      type="button"
      className={buildClassName(kit.ib, styles.offlineCircle, isHeld && styles.offlineOn)}
      aria-label={label}
      aria-pressed={isHeld}
      title={label}
      disabled={!ids.length}
      data-music-save-offline={isDone ? 'saved' : isSaving ? 'saving' : isHeld ? 'partial' : 'none'}
      onClick={handleClick}
    >
      <ParvaneIcon name={isHeld ? 'downloaded' : 'download'} />
    </button>
  );
};

export default memo(MusicOfflineCircle);
