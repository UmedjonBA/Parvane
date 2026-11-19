import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { getOfflineState } from './musicOffline';
import { getCurrentTrack, getMusicPlayer, setTrackStarred } from './musicPlayer';
import { closeMusicPlayer } from './musicPlayerView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import Modal from '../../ui/Modal';
import MusicControls from './MusicControls';
import MusicCover from './MusicCover';
import MusicPlaylistPicker from './MusicPlaylistPicker';
import MusicQueue from './MusicQueue';
import MusicSendDialog from './MusicSendDialog';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicPlayerScreen.module.scss';

const MusicPlayerScreen = () => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const track = getCurrentTrack(player);
  const offline = useDerivedState(getOfflineState);
  const [isExpanded, setIsExpanded] = useState(false);
  const [playlistTrack, setPlaylistTrack] = useState<MusicTrack>();
  const [sendTrack, setSendTrack] = useState<MusicTrack>();

  useLayoutEffect(() => {
    if (!track) closeMusicPlayer();
  }, [track]);

  const toggleExpanded = useLastCallback(() => setIsExpanded(!isExpanded));
  const toggleStar = useLastCallback(() => {
    if (track) void setTrackStarred(track, !track.isStarred);
  });
  const openPlaylist = useLastCallback(() => setPlaylistTrack(track));
  const closePlaylist = useLastCallback(() => setPlaylistTrack(undefined));
  const openSend = useLastCallback(() => setSendTrack(track));
  const closeSend = useLastCallback(() => setSendTrack(undefined));

  if (!track) return undefined;

  const isOffline = offline.entries.some(({ track: entry }) => entry.id === track.id);
  return (
    <>
      <Modal
        isOpen
        isLowStackPriority
        dialogClassName={styles.dialog}
        contentClassName={styles.content}
        onClose={closeMusicPlayer}
      >
        <div className={buildClassName(styles.layout, isExpanded && styles.expanded)} data-music-full>
          <div className={styles.stage}>
            <button
              type="button"
              className={buildClassName(kit.btn, styles.collapse)}
              aria-label={lang('MusicCollapse')}
              onClick={closeMusicPlayer}
            >
              <ParvaneIcon name="right" className={styles.down} />
              <span className={styles.desktopLabel}>{lang('MusicCollapse')}</span>
            </button>
            <div className={styles.source}>
              <span>{lang('MusicPlayer')}</span>
              <strong className={styles.sourceName}>{track.album || track.title}</strong>
            </div>
            <MusicCover
              coverId={track.coverId}
              toneId={track.albumId || track.id}
              size={280}
              className={styles.art}
              isLarge
            />
            <div className={styles.info}>
              <h2 className={styles.title}>{track.title}</h2>
              <span className={kit.muted}>
                {track.artist}
                <span className={styles.desktopLabel}>
                  {track.album && ` · ${track.album}`}
                </span>
              </span>
              {isOffline && <span className={styles.saved}>{lang('MusicSavedOnDevice')}</span>}
            </div>
            <div className={styles.transport}>
              <MusicControls isFullScreen />
              {player.hasError && <span role="alert">{lang('MusicPlayError')}</span>}
            </div>
            <button
              type="button"
              className={buildClassName(kit.btn, styles.star, track.isStarred && styles.on)}
              onClick={toggleStar}
              aria-label={lang(track.isStarred ? 'MusicUnstar' : 'MusicStar')}
              aria-pressed={track.isStarred}
            >
              <ParvaneIcon name="heart" />
              <span className={styles.desktopLabel}>{lang(track.isStarred ? 'MusicInFavourites' : 'MusicStar')}</span>
            </button>
            <button
              type="button"
              className={buildClassName(kit.btn, styles.playlist)}
              onClick={openPlaylist}
              aria-label={lang('MusicAddToPlaylist')}
            >
              <ParvaneIcon name="list" />
              <span className={styles.desktopLabel}>{lang('MusicAddToPlaylist')}</span>
            </button>
            <button
              type="button"
              className={buildClassName(kit.btn, styles.send)}
              onClick={openSend}
              aria-label={lang('MusicSendToChat')}
            >
              <ParvaneIcon name="chat" />
              <span className={styles.desktopLabel}>{lang('MusicSendToChat')}</span>
            </button>
          </div>
          <section
            className={styles.queue}
            aria-label={lang('MusicQueueTitle', { count: player.queue.upcoming.length })}
          >
            <MusicQueue isListOnly isExpanded={isExpanded} onToggleExpanded={toggleExpanded} />
          </section>
        </div>
      </Modal>
      {playlistTrack && (
        <Modal isOpen onClose={closePlaylist}>
          <MusicPlaylistPicker track={playlistTrack} onClose={closePlaylist} />
        </Modal>
      )}
      <MusicSendDialog track={sendTrack} onClose={closeSend} />
    </>
  );
};

export default memo(MusicPlayerScreen);
