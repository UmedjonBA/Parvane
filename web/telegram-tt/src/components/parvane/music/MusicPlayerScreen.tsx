import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicQueueSource } from './musicPlayer';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { coverTone } from './musicFormat';
import {
  callMusic, getCurrentTrack, getMusicPlayer, getMusicPosition, playQueueItem, setTrackStarred,
} from './musicPlayer';
import { closeMusicPlayer } from './musicPlayerView';
import { goToMusicView } from './musicView';
import useMusicData from './useMusicData';

import useAppLayout from '../../../hooks/useAppLayout';
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
import MusicTrackMenu from './MusicTrackMenu';

import styles from './MusicPlayerScreen.module.scss';

// «Играет из …» по виду источника (доски `MusicPlayer`, `XdMusic`)
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

// Parvane (макет «Музыки» 23 ноя, доски `MusicPlayer-02/03/06`, `XdMusic-02`): плеер во весь экран на цвете
// обложки — «Играет из …», обложка, название с ♥, позиция и кнопки, «Далее» карточкой (открывает очередь). Ниже
// прокруткой — текст песни (синхронный — подсвечена текущая строка) и «Об исполнителе». Компьютер: обложка слева,
// название крупно справа
type OwnProps = {
  // Компьютер: внутри «Музыки» вместо медиатеки и вида, нижний плеер остаётся (доска `XdMusic-02`)
  isInline?: boolean;
};

const MusicPlayerScreen = ({ isInline }: OwnProps) => {
  const lang = useLang();
  const { isMobile: isPhone } = useAppLayout();
  const player = useDerivedState(getMusicPlayer);
  const { positionSecs } = useDerivedState(getMusicPosition);
  const track = getCurrentTrack(player);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [playlistTracks, setPlaylistTracks] = useState<MusicTrack[]>();
  const [sendTrack, setSendTrack] = useState<MusicTrack>();
  const { data: lyrics } = useMusicData(track ? `lyrics:${track.id}` : undefined, () => (
    callMusic('parvaneMusicLyrics', { trackId: track!.id })
  ));

  useLayoutEffect(() => {
    if (!track) closeMusicPlayer();
  }, [track]);

  // Внутри «Музыки» окна нет — Escape закрывает плеер сам
  useLayoutEffect(() => (isInline ? captureEscKeyListener(closeMusicPlayer) : undefined), [isInline]);

  const handleStar = useLastCallback(() => {
    if (track) void setTrackStarred(track, !track.isStarred);
  });
  const handleOpenQueue = useLastCallback(() => setIsQueueOpen(true));
  const handleCloseQueue = useLastCallback(() => setIsQueueOpen(false));
  const handleOpenMenu = useLastCallback(() => setIsMenuOpen(true));
  const handleCloseMenu = useLastCallback(() => setIsMenuOpen(false));
  const handleClosePlaylist = useLastCallback(() => setPlaylistTracks(undefined));
  const handleCloseSend = useLastCallback(() => setSendTrack(undefined));
  const handlePlayNext = useLastCallback(() => playQueueItem(player.queue.index + 1));
  const handleOpenArtist = useLastCallback(() => {
    if (!track?.artistId) return;
    closeMusicPlayer();
    goToMusicView({ kind: 'artist', id: track.artistId });
  });

  if (!track) return undefined;

  const { source } = player;
  const sourceName = source?.name || (source?.kind === 'starred' ? lang('MusicStarred') : track.album);
  const nextId = player.queue.upcoming[player.queue.index + 1];
  const next = nextId ? player.tracksById[nextId] : undefined;
  const tone = coverTone(track.albumId || track.id);
  const lines = lyrics?.lines || [];
  const positionMs = positionSecs * 1000;
  const currentLine = lyrics?.isSynced ? lines.findLastIndex((line) => line.startMs <= positionMs) : -1;

  // «Далее»: следующий трек; очередь кончается — карточка всё равно открывает очередь
  function renderNext() {
    return (
      <div className={styles.next}>
        <button type="button" className={styles.nextMain} disabled={!next} onClick={handlePlayNext}>
          {next && (
            <MusicCover
              coverId={next.coverId}
              toneId={next.albumId || next.id}
              size={32}
              className={styles.nextCover}
            />
          )}
          <span className={styles.nextText}>
            <span className={styles.nextCaps}>{lang('MusicNextShort')}</span>
            <span className={styles.nextTitle}>
              {next ? `${next.title} · ${next.artist}` : lang('MusicQueueEnd')}
            </span>
          </span>
        </button>
        <button
          type="button"
          className={styles.nextQueue}
          aria-label={lang('MusicQueue')}
          data-music-open-queue
          onClick={handleOpenQueue}
        >
          <ParvaneIcon name="chevronUp" />
        </button>
      </div>
    );
  }

  function renderLyrics() {
    if (!lines.length) return undefined;
    return (
      <section className={styles.card} data-music-lyrics={lyrics?.isSynced ? 'synced' : 'plain'}>
        <h3 className={styles.cardTitle}>{lang('MusicLyrics')}</h3>
        <div className={styles.lyrics}>
          {lines.map((line, position) => (
            <p
              key={`${position}:${line.startMs}`}
              className={buildClassName(
                styles.lyricsLine,
                lyrics?.isSynced && position === currentLine && styles.lyricsLineOn,
              )}
            >
              {line.text || ' '}
            </p>
          ))}
        </div>
      </section>
    );
  }

  function renderScreen() {
    const playing = track!;
    return (
      <div
        className={buildClassName(
          styles.screen,
          isPhone ? styles.screenPhone : styles.screenDesk,
          isInline && styles.screenInline,
        )}
        style={`--player-tone: ${tone}`}
        data-music-full
      >
        <header className={styles.top}>
          <button
            type="button"
            className={styles.topButton}
            aria-label={lang('MusicCollapsePlayer')}
            onClick={closeMusicPlayer}
          >
            <ParvaneIcon name={isPhone ? 'chevronDown' : 'close'} />
          </button>
          <div className={styles.source} data-music-source={source?.kind}>
            <span className={styles.sourceCaps}>{lang(SOURCE_KEYS[source?.kind || 'home'])}</span>
            <span className={styles.sourceName}>{sourceName}</span>
          </div>
          <button
            type="button"
            className={styles.topButton}
            aria-label={lang('MusicMoreActions')}
            data-music-player-menu
            onClick={handleOpenMenu}
          >
            <ParvaneIcon name="dotsH" />
          </button>
        </header>
        <div className={styles.body}>
          <div className={styles.stage}>
            <MusicCover
              coverId={playing.coverId}
              toneId={playing.albumId || playing.id}
              size={isPhone ? 320 : 300}
              className={styles.art}
              isLarge
            />
            <div className={styles.side}>
              <div className={styles.info}>
                <div className={styles.infoText}>
                  <h2 className={styles.title}>{playing.title}</h2>
                  <button type="button" className={styles.artist} onClick={handleOpenArtist}>
                    {isPhone ? playing.artist : [playing.artist, playing.album].filter(Boolean).join(' · ')}
                  </button>
                </div>
                <button
                  type="button"
                  className={buildClassName(styles.star, playing.isStarred && styles.starOn)}
                  aria-label={lang(playing.isStarred ? 'MusicUnstar' : 'MusicStar')}
                  aria-pressed={playing.isStarred}
                  data-music-player-star
                  onClick={handleStar}
                >
                  <ParvaneIcon name={playing.isStarred ? 'heart' : 'heartPlus'} />
                </button>
              </div>
              <MusicControls isFullScreen />
              {player.hasError && <span className={styles.error} role="alert">{lang('MusicPlayError')}</span>}
              {renderNext()}
            </div>
          </div>
          {renderLyrics()}
          {playing.artistId && (
            <section className={styles.card}>
              <h3 className={styles.cardTitle}>{lang('MusicAboutArtist')}</h3>
              <div className={styles.cardName}>{playing.artist}</div>
              <button type="button" className={styles.cardButton} onClick={handleOpenArtist}>
                {lang('MusicGoToArtist')}
              </button>
            </section>
          )}
        </div>
        {isQueueOpen && (
          <div className={styles.queueSheet} role="dialog" aria-label={lang('MusicQueue')} data-music-queue-sheet>
            <MusicQueue isSheet onClose={handleCloseQueue} onToPlaylist={handleQueueToPlaylist} />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {isInline ? renderScreen() : (
        <Modal
          isOpen
          isLowStackPriority
          dialogClassName={styles.dialog}
          contentClassName={styles.content}
          onClose={closeMusicPlayer}
        >
          {renderScreen()}
        </Modal>
      )}
      {isMenuOpen && (
        <MusicTrackMenu
          track={track}
          canSaveOffline
          onStar={handleStarTrack}
          onSendToChat={setSendTrack}
          onClose={handleCloseMenu}
        />
      )}
      {playlistTracks && <MusicPlaylistPicker tracks={playlistTracks} onClose={handleClosePlaylist} />}
      <MusicSendDialog track={sendTrack} onClose={handleCloseSend} />
    </>
  );

  function handleQueueToPlaylist(tracks: MusicTrack[]) {
    if (tracks.length) setPlaylistTracks(tracks);
  }

  function handleStarTrack(starred: MusicTrack) {
    void setTrackStarred(starred, !starred.isStarred);
  }
};

export default memo(MusicPlayerScreen);
