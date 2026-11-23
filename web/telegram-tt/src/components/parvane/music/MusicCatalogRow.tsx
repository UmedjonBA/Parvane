import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicCatalogTrack, MusicFetchJob } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';
import type { FetchFollowUp } from './fetch/musicFetch';
import type { MusicMenuAction } from './MusicMenu';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import {
  addFetchFollowUp, cancelFetchJob, catalogKey, getFetchJobs, getJobPercent, isJobActive, moveFetchFirst,
  retryFetchJob, startFetch,
} from './fetch/musicFetch';
import { callMusic, catalogPreviewTrack, playTracks } from './musicPlayer';
import { rememberMusicQuery } from './musicSearchHistory';
import { openMusicView, setMusicQuery } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';
import MusicMenu from './MusicMenu';
import MusicPlaylistPicker from './MusicPlaylistPicker';

import sheets from '../cloud/CloudSheets.module.scss';
import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  track: MusicCatalogTrack;
  // Место перед обложкой (страница исполнителя каталога, «Популярное»)
  rank?: number;
  // Вторая строка вместо исполнителя (альбом на странице исполнителя)
  sub?: string;
};

type State = 'catalog' | 'waiting' | 'adding' | 'processing' | 'failed' | 'choice';

const PHONE_MAX_WIDTH = 925;

// Parvane (макет «Музыки» 23 ноя, доски `MusicOverview`, `RpMusicA`): трек каталога, которого нет на сервере, —
// серое название и облачко под ним, справа «Добавить на сервер». Пока добавляется — кольцо (идёт), часики (ждёт
// очереди), ↻ (теги и обложка), ⚠ с «Повторить» (не удалось). Меню — «Добавить на сервер», переходы, «Не нравится»
const MusicCatalogRow = ({ track, rank, sub }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const jobs = useDerivedState(getFetchJobs);
  const [menu, setMenu] = useState<{ anchor?: CloudMenuAnchor }>();
  const key = catalogKey(track);
  const job = jobs.find((item) => catalogKey(item.track) === key && item.state !== 'done');
  const state = stateOf(job);
  const percent = job && getJobPercent(job);

  const handleAdd = useLastCallback(async () => {
    rememberMusicQuery();
    const result = await startFetch(track);
    if (result === 'limit') showNotification({ message: lang('MusicFetchLimit') });
    else if (result === 'duplicate') showNotification({ message: lang('MusicFetchDuplicate') });
    else if (result === 'failed') showNotification({ message: lang('MusicFetchFailedShort') });
  });
  // Уверенного совпадения нет — файл выбирают в «Загрузках на сервер»
  const handleChoose = useLastCallback(() => openMusicView({ kind: 'uploads' }));
  const handleRetry = useLastCallback(() => {
    if (job) void retryFetchJob(job);
  });
  const handleMenu = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ anchor: window.innerWidth <= PHONE_MAX_WIDTH ? undefined : { x: box.left, y: box.bottom } });
  });
  const handleContextMenu = useLastCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ anchor: window.innerWidth <= PHONE_MAX_WIDTH ? undefined : { x: e.clientX, y: e.clientY } });
  });
  const handleCloseMenu = useLastCallback(() => setMenu(undefined));
  const [isPicking, setIsPicking] = useState(false);
  // Нажатие строки — отрывок 30 с (доски `RpMusicA-05`, `MusicPlayer-05`)
  const handlePreview = useLastCallback(() => {
    playTracks([catalogPreviewTrack(track)], 0, { source: { kind: 'search', name: track.artist } });
  });
  // После скачивания: «В Любимое», «В очередь», «В плейлист» (доски `RpMusicA-04/07`)
  const handleFollowUp = useLastCallback(async (followUp: FetchFollowUp) => {
    if (job && isJobActive(job)) {
      addFetchFollowUp(job.jobId, followUp);
      if (followUp.isStar) showNotification({ message: lang('MusicStarWhenAdded') });
      return;
    }
    rememberMusicQuery();
    const result = await startFetch(track, followUp);
    if (result === 'limit') showNotification({ message: lang('MusicFetchLimit') });
    else if (result === 'failed') showNotification({ message: lang('MusicFetchFailedShort') });
  });
  const handlePickPlaylists = useLastCallback((playlists: { id: string; isShared: boolean }[]) => {
    void handleFollowUp({ playlists });
  });
  const handleClosePicker = useLastCallback(() => setIsPicking(false));
  const handlePick = useLastCallback((action: string) => {
    setMenu(undefined);
    if (action === 'add') void handleAdd();
    else if (action === 'preview') handlePreview();
    else if (action === 'star') void handleFollowUp({ isStar: true });
    else if (action === 'queue') void handleFollowUp({ isQueue: true });
    else if (action === 'playlist') setIsPicking(true);
    else if (action === 'first' && job) void moveFetchFirst(job.jobId);
    else if (action === 'cancel' && job) void cancelFetchJob(job.jobId);
    else if (action === 'artist') {
      setMusicQuery(track.artist);
      openMusicView({ kind: 'search' }, true);
    } else if (action === 'album' && track.albumRef) openMusicView({ kind: 'catalogAlbum', id: track.albumRef });
    else if (action === 'dislike') {
      void callMusic('parvaneMusicDislike', { ref: track.ref, artist: track.artist, title: track.title })
        .then(() => showNotification({ message: lang('MusicDisliked') }));
    } else if (action === 'share') {
      copyTextToClipboard(`${track.title} — ${track.artist}`);
      showNotification({ message: lang('MusicShareCopied') });
    }
  });

  const icon = (name: ParvaneIconName) => <ParvaneIcon name={name} className={sheets.menuIcon} />;
  const isBusy = state === 'waiting' || state === 'adding' || state === 'processing';
  // Добавляется (доска `RpMusicA-07`): «Слушать · В Любимое · В очередь», «Добавить первым», «Отменить»
  const quick: MusicMenuAction[] = isBusy ? [
    ...(track.previewUrl ? [{ key: 'preview', title: lang('MusicListen'), glyph: icon('play') }] : []),
    { key: 'star', title: lang('MusicStarShort'), glyph: icon('heart') },
    { key: 'queue', title: lang('MusicToQueue'), glyph: icon('list') },
  ] : [
    // Каталог (доска `RpMusicA-04`): «В Любимое · В плейлист · В очередь · Поделиться»
    { key: 'star', title: lang('MusicStarShort'), glyph: icon('heart') },
    { key: 'playlist', title: lang('MusicToPlaylist'), glyph: icon('plus') },
    { key: 'queue', title: lang('MusicToQueue'), glyph: icon('list') },
    { key: 'share', title: lang('MusicShare'), glyph: icon('share') },
  ];
  const actions: MusicMenuAction[] = isBusy ? [
    ...(state === 'waiting' ? [{ key: 'first', title: lang('MusicFetchFirst'), glyph: icon('chevronUp') }] : []),
    { key: 'cancel', title: lang('MusicFetchCancelShort'), glyph: icon('close'), isDanger: true },
  ] : [
    { key: 'add', title: lang('MusicAddToServer'), glyph: icon('cloudAdd') },
    ...(track.previewUrl ? [{ key: 'preview', title: lang('MusicListenPreview'), glyph: icon('play') }] : []),
    { key: 'artist', title: lang('MusicGoToArtist'), glyph: icon('mic') },
    ...(track.albumRef ? [{ key: 'album', title: lang('MusicGoToAlbum'), glyph: icon('disc') }] : []),
    { key: 'dislike', title: lang('MusicDislike'), glyph: icon('ban') },
  ];
  const menuState = state === 'adding' && percent !== undefined
    ? lang('MusicStateAddingPercent', { percent }) : lang(STATE_KEYS[state]);
  const subText = sub ?? track.artist;

  return (
    <li
      className={buildClassName(styles.track, styles.trackCatalog)}
      data-catalog-track={track.ref || key}
      data-catalog-state={state}
      onContextMenu={handleContextMenu}
    >
      <button type="button" className={styles.trackMain} onClick={track.previewUrl ? handlePreview : handleMenu}>
        {rank !== undefined && (
          <span className={styles.trackRank}>{rank}</span>
        )}
        <MusicCover
          coverUrl={track.coverUrl}
          toneId={track.albumRef || track.ref || key}
          size={46}
          className={styles.trackCover}
        />
        <span className={styles.trackText}>
          <span className={buildClassName(styles.trackTitle, state === 'catalog' && styles.trackTitleMuted)}>
            {track.title}
          </span>
          <span className={styles.trackArtist}>
            {state === 'adding' ? (
              <span className={styles.trackRing} aria-hidden />
            ) : (
              <ParvaneIcon
                name={STATE_ICONS[state]}
                isSmall
                className={buildClassName(styles.trackState, STATE_CLASSES[state])}
              />
            )}
            <span className={styles.trackArtistText}>
              {state === 'adding' && percent !== undefined ? `${subText} · ${percent}%` : subText}
            </span>
          </span>
        </span>
      </button>
      {state === 'catalog' && (
        <button
          type="button"
          className={buildClassName(kit.ib, styles.trackMenu, styles.trackAction)}
          aria-label={lang('MusicAddToServerNamed', { name: track.title })}
          data-catalog-add
          onClick={handleAdd}
        >
          <ParvaneIcon name="cloudAdd" isSmall />
        </button>
      )}
      {state === 'choice' && (
        <button
          type="button"
          className={buildClassName(kit.ib, styles.trackMenu)}
          data-catalog-choose
          onClick={handleChoose}
        >
          <ParvaneIcon name="list" isSmall />
        </button>
      )}
      {state === 'failed' && (
        <button
          type="button"
          className={buildClassName(kit.ib, styles.trackMenu, styles.trackRetry)}
          aria-label={lang('MusicRetryNamed', { name: track.title })}
          onClick={handleRetry}
        >
          <ParvaneIcon name="refresh" isSmall />
        </button>
      )}
      <button
        type="button"
        className={buildClassName(kit.ib, styles.trackMenu)}
        aria-label={lang('MusicTrackActions', { name: track.title })}
        aria-haspopup="menu"
        data-music-menu
        onClick={handleMenu}
      >
        <ParvaneIcon name="dotsH" isSmall />
      </button>
      {menu && (
        <MusicMenu
          title={track.title}
          facts={[track.artist, menuState].join(' · ')}
          cover={(
            <MusicCover
              coverUrl={track.coverUrl}
              toneId={track.albumRef || track.ref || key}
              size={40}
              className={styles.trackCover}
            />
          )}
          quick={quick}
          actions={actions}
          anchor={menu.anchor}
          onPick={handlePick}
          onClose={handleCloseMenu}
        />
      )}
      {isPicking && (
        <MusicPlaylistPicker
          tracks={[catalogPreviewTrack(track)]}
          subtitle={lang('MusicFromCatalogNamed', { name: track.title })}
          onPick={handlePickPlaylists}
          onClose={handleClosePicker}
        />
      )}
    </li>
  );
};

const STATE_ICONS: Record<State, ParvaneIconName> = {
  catalog: 'cloudLine',
  waiting: 'clock',
  adding: 'refresh',
  processing: 'refresh',
  failed: 'warn',
  choice: 'warn',
};
const STATE_CLASSES: Record<State, string | undefined> = {
  catalog: undefined,
  waiting: undefined,
  adding: undefined,
  processing: styles.trackStateBusy,
  failed: styles.trackStateFailed,
  choice: styles.trackStateBusy,
};
const STATE_KEYS = {
  catalog: 'MusicStateCatalog',
  waiting: 'MusicStateWaiting',
  adding: 'MusicStateAdding',
  processing: 'MusicStateProcessing',
  failed: 'MusicStateFailed',
  choice: 'MusicStateChoice',
} as const;

function stateOf(job?: MusicFetchJob): State {
  if (!job) return 'catalog';
  if (job.state === 'failed') return 'failed';
  if (job.state === 'choice') return 'choice';
  if (job.state === 'queued') return 'waiting';
  if (job.state === 'downloading' && job.bytesTotal && job.bytesDone >= job.bytesTotal) return 'processing';
  return 'adding';
}

export default memo(MusicCatalogRow);
