import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicQueueSource } from './musicPlayer';

import buildClassName from '../../../util/buildClassName';
import { getOfflineState, isTrackSaving, removeOffline, saveTracksOffline } from './musicOffline';
import { getCurrentTrack, getMusicPlayer, setTrackStarred } from './musicPlayer';
import { closeMusicPlayer } from './musicPlayerView';

import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import Modal from '../../ui/Modal';
import MusicControls from './MusicControls';
import MusicCover from './MusicCover';
import MusicOfflineButton from './MusicOfflineButton';
import MusicPlaylistPicker from './MusicPlaylistPicker';
import MusicQueue from './MusicQueue';
import MusicSendDialog from './MusicSendDialog';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicPlayerScreen.module.scss';

// «Играет из плейлиста / альбома / любимого…» (доска `MusicPlayer`)
const SOURCE_KEYS = {
  playlist: 'MusicFromPlaylist',
  album: 'MusicFromAlbum',
  artist: 'MusicFromArtist',
  starred: 'MusicFromStarred',
  offline: 'MusicFromOffline',
  search: 'MusicFromSearch',
  home: 'MusicFromHome',
  chat: 'MusicFromChat',
} as const satisfies Record<MusicQueueSource['kind'], string>;
// Сноска под очередью на компьютере (доска `XdMusic`): «Источник: плейлист «Для работы»»
const SOURCE_NOTE_KEYS = {
  playlist: 'MusicSourcePlaylist',
  album: 'MusicSourceAlbum',
  artist: 'MusicSourceArtist',
  starred: 'MusicSourceStarred',
  search: 'MusicSourceSearch',
} as const satisfies Partial<Record<MusicQueueSource['kind'], string>>;

// Parvane (spec 039, 041; доски `MusicPlayer` — телефон, `XdMusic` — компьютер): полный плеер — обложка, название,
// позиция, управление; телефон: «Играет из …» сверху, сердце и «на устройство» рядом с названием, «Далее в
// очереди» снизу; компьютер: «Свернуть», чипы «В любимом · Скачан · В плейлист · Отправить в чат», справа очередь
// со сноской об источнике
const MusicPlayerScreen = () => {
  const lang = useLang();
  const { isMobile: isPhone } = useAppLayout();
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
  const toggleOffline = useLastCallback(() => {
    if (!track) return;
    if (offline.entries.some((entry) => entry.track.id === track.id)) void removeOffline([track.id]);
    else saveTracksOffline([track]);
  });
  const openPlaylist = useLastCallback(() => setPlaylistTrack(track));
  const closePlaylist = useLastCallback(() => setPlaylistTrack(undefined));
  const openSend = useLastCallback(() => setSendTrack(track));
  const closeSend = useLastCallback(() => setSendTrack(undefined));

  if (!track) return undefined;

  const { source } = player;
  const isSaved = offline.entries.some((entry) => entry.track.id === track.id);
  const isSaving = !isSaved && offline.pending > 0 && isTrackSaving(track.id);
  const sourceName = source?.name || (source?.kind === 'starred' ? lang('MusicStarred') : track.album);

  function renderChips() {
    return (
      <div className={styles.chips}>
        <button
          type="button"
          className={buildClassName(kit.chip, track!.isStarred && kit.chipOn)}
          aria-pressed={track!.isStarred}
          aria-label={lang(track!.isStarred ? 'MusicUnstar' : 'MusicStar')}
          onClick={toggleStar}
        >
          {lang(track!.isStarred ? 'MusicInFavourites' : 'MusicStarShort')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.chip, isSaved && kit.chipOn)}
          aria-pressed={isSaved}
          disabled={isSaving}
          data-music-offline-track={isSaved ? 'saved' : isSaving ? 'saving' : 'none'}
          onClick={toggleOffline}
        >
          {lang(isSaved ? 'MusicChipSaved' : isSaving ? 'MusicOfflineSaving' : 'MusicChipSave')}
        </button>
        <button type="button" className={kit.chip} onClick={openPlaylist}>{lang('MusicToPlaylist')}</button>
        <button type="button" className={kit.chip} onClick={openSend}>{lang('MusicSendToChat')}</button>
      </div>
    );
  }

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
              aria-label={lang('MusicCollapsePlayer')}
              onClick={closeMusicPlayer}
            >
              <ParvaneIcon name="right" className={styles.down} />
              <span className={styles.desktopLabel}>{lang('MusicCollapse')}</span>
            </button>
            <div className={styles.source} data-music-source={source?.kind}>
              <span>{lang(SOURCE_KEYS[source?.kind || 'home'])}</span>
              <strong className={styles.sourceName}>{sourceName}</strong>
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
            </div>
            <div className={styles.transport}>
              <MusicControls isFullScreen />
              {player.hasError && <span role="alert">{lang('MusicPlayError')}</span>}
            </div>
            {isPhone ? (
              <>
                <button
                  type="button"
                  className={buildClassName(kit.btn, styles.star, track.isStarred && styles.on)}
                  onClick={toggleStar}
                  aria-label={lang(track.isStarred ? 'MusicUnstar' : 'MusicStar')}
                  aria-pressed={track.isStarred}
                >
                  <ParvaneIcon name="heart" className={track.isStarred ? styles.heartFilled : undefined} />
                </button>
                <MusicOfflineButton track={track} className={styles.saved} />
                <button
                  type="button"
                  className={buildClassName(kit.btn, styles.send)}
                  onClick={openSend}
                  aria-label={lang('MusicSendToChat')}
                >
                  <ParvaneIcon name="send" />
                </button>
                <button
                  type="button"
                  className={buildClassName(kit.btn, styles.playlist)}
                  onClick={openPlaylist}
                  aria-label={lang('MusicAddToPlaylist')}
                >
                  <ParvaneIcon name="list" />
                </button>
              </>
            ) : renderChips()}
          </div>
          <section
            className={styles.queue}
            aria-label={lang('MusicQueueTitle', { count: player.queue.upcoming.length })}
          >
            <MusicQueue
              isUpcomingOnly={isPhone}
              isExpanded={isExpanded}
              onToggleExpanded={isPhone ? toggleExpanded : undefined}
            />
            {!isPhone && (
              <div className={buildClassName(kit.muted, kit.small, styles.queueNote)} data-music-queue-note>
                {lang('MusicQueueNote')}
                {source && source.kind in SOURCE_NOTE_KEYS && ` ${lang(
                  SOURCE_NOTE_KEYS[source.kind as keyof typeof SOURCE_NOTE_KEYS], { name: sourceName || '' },
                )}`}
              </div>
            )}
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
