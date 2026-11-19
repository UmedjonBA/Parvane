import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiMusicPlaylistCard } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime, splitListTime } from './musicFormat';
import { playTracks } from './musicPlayer';
import { loadSharedTracks, saveSharedPlaylist } from './musicSharedPlaylist';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  isOpen: boolean;
  playlist: ApiMusicPlaylistCard;
  // Треки — из библиотеки своего сервера и «Музыка» включена: можно слушать и сохранить к себе
  canPlay: boolean;
  onClose: NoneToVoidFunction;
};

// Parvane (PLAYLIST-1): плейлист из чата целиком — треки по порядку, «Слушать» с любого трека и «Сохранить к себе»
// (новый плейлист своего контейнера). Список — снимок отправителя: правки его плейлиста сюда не приходят
const MusicPlaylistSheet = ({
  isOpen, playlist, canPlay, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isSaving, setIsSaving] = useState(false);
  const count = playlist.tracks.length;
  const time = splitListTime(playlist.tracks.reduce((sum, track) => sum + track.durationSecs, 0));

  const handlePlay = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const startId = e.currentTarget.dataset.track;
    const tracks = await loadSharedTracks(playlist).catch(() => []);
    if (!tracks.length) {
      showNotification({ message: { key: 'MusicPlaylistCardMissing' } });
      return;
    }
    playTracks(tracks, Math.max(0, tracks.findIndex((track) => track.id === startId)));
  });

  const handleSave = useLastCallback(async () => {
    setIsSaving(true);
    const isSaved = await saveSharedPlaylist(playlist).catch(() => false);
    setIsSaving(false);
    showNotification({ message: { key: isSaved ? 'MusicPlaylistSaved' : 'MusicPlaylistNotSaved' } });
    if (isSaved) onClose();
  });

  return (
    <PvSheet isOpen={isOpen} title={playlist.name} onClose={onClose}>
      <div className={styles.playlist} data-music-playlist-sheet>
        <div className={buildClassName(kit.muted, kit.small, kit.mono)}>
          {`${lang('MusicTracksCount', { count }, { pluralValue: count })} · `}
          {lang('MusicListTime', { hours: time.hours, minutes: time.minutes })}
        </div>
        {canPlay && (
          <div className={styles.listHead}>
            <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handlePlay}>
              {lang('MusicPlaylistCardListen')}
            </button>
            <button
              type="button"
              className={kit.btn}
              disabled={isSaving}
              data-music-playlist-save
              onClick={handleSave}
            >
              {lang('MusicPlaylistSave')}
            </button>
          </div>
        )}
        <ol className={styles.tracks}>
          {playlist.tracks.map((track, index) => (
            <li key={track.trackId} className={styles.track} data-track={track.trackId}>
              <button
                type="button"
                className={styles.trackMain}
                data-track={track.trackId}
                disabled={!canPlay}
                onClick={handlePlay}
              >
                <span className={buildClassName(kit.mono, kit.muted, kit.small, styles.trackNo)}>{index + 1}</span>
                <span className={styles.trackText}>
                  <span className={styles.trackTitle}>{track.title}</span>
                  <span className={buildClassName(kit.muted, kit.small, styles.trackArtist)}>{track.artist}</span>
                </span>
                <span className={buildClassName(kit.mono, kit.muted, kit.small)}>
                  {formatTrackTime(track.durationSecs)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </PvSheet>
  );
};

export default memo(MusicPlaylistSheet);
