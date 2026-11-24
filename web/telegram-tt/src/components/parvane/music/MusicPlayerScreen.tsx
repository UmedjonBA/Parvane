import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicQueueSource } from './musicPlayer';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { catalogKey, getFetchJobs, startFetch } from './fetch/musicFetch';
import { coverTone } from './musicFormat';
import {
  callMusic, getCurrentTrack, getMusicInfo, getMusicPlayer, getMusicPosition, getPreviewCatalogTrack, playQueueItem,
  setTrackStarred, togglePlay,
} from './musicPlayer';
import { closeMusicPlayer } from './musicPlayerView';
import { goToMusicView, openUploadsWith } from './musicView';
import useMusicData from './useMusicData';

import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import Modal from '../../ui/Modal';
import MusicControls from './MusicControls';
import MusicCover from './MusicCover';
import MusicPlayerAbout from './MusicPlayerAbout';
import MusicPlaylistPicker from './MusicPlaylistPicker';
import MusicQueue from './MusicQueue';
import MusicSendDialog from './MusicSendDialog';
import MusicTrackMenu from './MusicTrackMenu';

import styles from './MusicPlayerScreen.module.scss';

// «Играет из …» по виду источника (доски `MusicPlayer`, `XdMusic`)
// Прокрутка тела плеера, после которой шапка становится компактной
const COMPACT_SCROLL_PX = 120;

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
  const info = useDerivedState(getMusicInfo);
  const jobs = useDerivedState(getFetchJobs);
  const { positionSecs } = useDerivedState(getMusicPosition);
  const track = getCurrentTrack(player);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  // Меню трека: на компьютере — у кнопки «⋯», на телефоне — шторкой
  const [menu, setMenu] = useState<{ anchor?: { x: number; y: number } }>();
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
  // Системное «назад» (жест Android) закрывает плеер, а не приложение
  useHistoryBack({ isActive: true, onBack: closeMusicPlayer });

  // Телефон, прокрутка к карточкам (доска `MusicPlayer-03`): вверху — обложка, название и пауза вместо «Играет из»
  const [isCompact, setIsCompact] = useState(false);
  const handleScroll = useLastCallback((e: React.UIEvent<HTMLDivElement>) => {
    const isPast = e.currentTarget.scrollTop > COMPACT_SCROLL_PX;
    if (isPast !== isCompact) setIsCompact(isPast);
  });
  const handleToServer = useLastCallback(() => {
    const catalog = track && getPreviewCatalogTrack(track.id);
    if (catalog) void startFetch(catalog);
  });
  const handleHaveFile = useLastCallback(() => {
    closeMusicPlayer();
    openUploadsWith('file');
  });
  const handleStar = useLastCallback(() => {
    if (track) void setTrackStarred(track, !track.isStarred);
  });
  const handleOpenQueue = useLastCallback(() => setIsQueueOpen(true));
  const handleCloseQueue = useLastCallback(() => setIsQueueOpen(false));
  const handleOpenMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ anchor: isPhone ? undefined : { x: rect.left, y: rect.bottom } });
  });
  const handleCloseMenu = useLastCallback(() => setMenu(undefined));
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

  // Отрывок каталога (доски `MusicPlayer-04/05`): «На сервер» — скачать трек; не нашёлся в источниках — «Есть файл?»
  function renderPreviewAction() {
    const catalog = getPreviewCatalogTrack(track!.id);
    const job = catalog && jobs.find((item) => catalogKey(item.track) === catalogKey(catalog));
    if (!catalog || job?.state === 'done') return undefined;
    if (job?.state === 'failed' || !info?.isFetchEnabled) {
      if (!info?.isUploadEnabled) return undefined;
      return (
        <button type="button" className={styles.previewAction} data-music-preview-file onClick={handleHaveFile}>
          {lang('MusicHaveFile')}
        </button>
      );
    }
    const isBusy = Boolean(job && job.state !== 'choice');
    return (
      <button
        type="button"
        className={buildClassName(styles.previewAction, styles.previewActionAcc)}
        disabled={isBusy}
        data-music-preview-fetch
        onClick={handleToServer}
      >
        <ParvaneIcon name="cloudAdd" isSmall />
        {lang(isBusy ? 'MusicStateAdding' : 'MusicToServer')}
      </button>
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
          {isCompact ? (
            <div className={styles.topTrack} data-music-top-track>
              <MusicCover
                coverId={playing.coverId}
                coverUrl={playing.coverUrl}
                toneId={playing.albumId || playing.id}
                size={36}
                className={styles.topCover}
              />
              <span className={styles.topText}>
                <span className={styles.topTitle}>{playing.title}</span>
                <span className={styles.topArtist}>{playing.artist}</span>
              </span>
            </div>
          ) : (
            <div className={styles.source} data-music-source={source?.kind}>
              <span className={styles.sourceCaps}>{lang(SOURCE_KEYS[source?.kind || 'home'])}</span>
              <span className={styles.sourceName}>{sourceName}</span>
            </div>
          )}
          {isCompact ? (
            <button
              type="button"
              className={styles.topButton}
              aria-label={lang(player.isPlaying ? 'MusicPause' : 'MusicPlay')}
              onClick={togglePlay}
            >
              <ParvaneIcon name={player.isPlaying ? 'pause' : 'play'} />
            </button>
          ) : (
            <button
              type="button"
              className={styles.topButton}
              aria-label={lang('MusicMoreActions')}
              data-music-player-menu
              onClick={handleOpenMenu}
            >
              <ParvaneIcon name="dotsH" />
            </button>
          )}
        </header>
        <div className={styles.body} onScroll={isPhone ? handleScroll : undefined}>
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
              {/* Доска `MusicPlayer-05`: трек каталога — только отрывок */}
              {(playing.previewUrl || playing.isNetwork) && (
                <div className={styles.previewRow}>
                  <span className={styles.previewNote} data-music-preview={playing.isNetwork ? 'network' : 'preview'}>
                    {lang(playing.isNetworkFallback ? 'MusicNetworkPreviewOnly'
                      : playing.isNetwork ? 'MusicNetworkOnly' : 'MusicPreviewOnly')}
                  </span>
                  {renderPreviewAction()}
                </div>
              )}
              {renderNext()}
            </div>
          </div>
          {renderLyrics()}
          <MusicPlayerAbout track={playing} />
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
      {menu && (
        <MusicTrackMenu
          track={track}
          anchor={menu.anchor}
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
