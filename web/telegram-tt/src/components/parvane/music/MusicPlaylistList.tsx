import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { getOfflineHolds, getOfflineState } from './musicOffline';
import { getPlaylists, getPlaylistsStatus } from './musicPlaylists';
import { openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import MusicCover from './MusicCover';
import MusicSharedRows from './shared/MusicSharedRows';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

const STATUS_KEYS = {
  'needs-linking': 'MusicPlaylistsNeedLinking',
  'no-key': 'MusicPlaylistsNoKey',
  offline: 'MusicPlaylistsOffline',
} as const;

// Parvane (spec 041, доска `MusicLibrary`): плейлисты строками — плитка тоном, название, «N треков · мой», значок
// «Загружен для офлайна»; нажатие открывает плейлист
const MusicPlaylistList = () => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const status = useDerivedState(getPlaylistsStatus);
  // Перерисовка при смене «Загруженного»: отметки плейлистов читаются из `getOfflineHolds`
  useDerivedState(getOfflineState);
  const held = getOfflineHolds().playlists;

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'playlist', id: e.currentTarget.dataset.playlist! });
  });

  // Общие плейлисты (MUSIC-3) — строками после своих; они на сервере и не ждут контейнера личных
  const shared = <MusicSharedRows withServer />;
  if (status !== 'ready' && status !== 'loading') {
    return (
      <>
        <div className={styles.error} role="status" data-playlists-status={status}>{lang(STATUS_KEYS[status])}</div>
        {shared}
      </>
    );
  }
  if (!playlists.length) {
    return (
      <>
        <PvEmpty text={lang(status === 'loading' ? 'Loading' : 'MusicPlaylistsEmpty')} data-music-empty="playlists" />
        {shared}
      </>
    );
  }

  return (
    <>
      <ul className={styles.tracks} data-music-playlists>
        {playlists.map((playlist) => (
          <li key={playlist.id} className={styles.track}>
            <button type="button" className={styles.trackMain} data-playlist={playlist.id} onClick={handleOpen}>
              <MusicCover toneId={playlist.id} size={40} glyph="list" className={styles.trackCover} />
              <span className={styles.trackText}>
                <span className={styles.trackTitle}>{playlist.name}</span>
                <span className={buildClassName(kit.muted, kit.small)}>
                  {[lang('MusicTracksCount', { count: playlist.count }, { pluralValue: playlist.count }),
                    lang('MusicPlaylistMine')].join(' · ')}
                </span>
              </span>
              {held[playlist.id] && (
                <span className={styles.offlineOn} role="img" aria-label={lang('MusicPlaylistOfflineMark')}>
                  <ParvaneIcon name="downloaded" isSmall />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {shared}
    </>
  );
};

export default memo(MusicPlaylistList);
