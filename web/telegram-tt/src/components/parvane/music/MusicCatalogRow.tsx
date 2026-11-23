import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicCatalogTrack, MusicFetchJob } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';
import type { MusicMenuAction } from './MusicMenu';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import {
  cancelFetchJob, catalogKey, getFetchJobs, getJobPercent, retryFetchJob, startFetch,
} from './fetch/musicFetch';
import { callMusic, catalogPreviewTrack, playTracks } from './musicPlayer';
import { openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';
import MusicMenu from './MusicMenu';

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

type State = 'catalog' | 'waiting' | 'adding' | 'processing' | 'failed';

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
    const result = await startFetch(track);
    if (result === 'limit') showNotification({ message: lang('MusicFetchLimit') });
    else if (result === 'duplicate') showNotification({ message: lang('MusicFetchDuplicate') });
    else if (result === 'failed') showNotification({ message: lang('MusicFetchFailedShort') });
  });
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
  // Нажатие строки — отрывок 30 с (доски `RpMusicA-05`, `MusicPlayer-05`)
  const handlePreview = useLastCallback(() => {
    playTracks([catalogPreviewTrack(track)], 0, { source: { kind: 'search', name: track.artist } });
  });
  const handlePick = useLastCallback((action: string) => {
    setMenu(undefined);
    if (action === 'add') void handleAdd();
    else if (action === 'preview') handlePreview();
    else if (action === 'cancel' && job) void cancelFetchJob(job.jobId);
    else if (action === 'album' && track.albumRef) openMusicView({ kind: 'catalogAlbum', id: track.albumRef });
    else if (action === 'dislike') {
      void callMusic('parvaneMusicDislike', { ref: track.ref, artist: track.artist, title: track.title })
        .then(() => showNotification({ message: lang('MusicDisliked') }));
    } else if (action === 'share') {
      copyTextToClipboard(`${track.title} — ${track.artist}`);
      showNotification({ message: lang('MusicShareCopied') });
    }
  });

  const icon = (name: ParvaneIconName) => <ParvaneIcon name={name} className={sheets.menuIcon} />;
  const actions: MusicMenuAction[] = [
    state === 'catalog' || state === 'failed'
      ? { key: 'add', title: lang('MusicAddToServer'), glyph: icon('cloudAdd') }
      : { key: 'cancel', title: lang('MusicFetchCancel'), glyph: icon('close'), isDanger: true },
    ...(track.previewUrl ? [{ key: 'preview', title: lang('MusicListenPreview'), glyph: icon('play') }] : []),
    ...(track.albumRef ? [{ key: 'album', title: lang('MusicGoToAlbum'), glyph: icon('disc') }] : []),
    { key: 'share', title: lang('MusicShare'), glyph: icon('share') },
    { key: 'dislike', title: lang('MusicDislike'), glyph: icon('ban') },
  ];
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
          facts={[track.artist, lang(STATE_KEYS[state])].join(' · ')}
          cover={(
            <MusicCover
              coverUrl={track.coverUrl}
              toneId={track.albumRef || track.ref || key}
              size={40}
              className={styles.trackCover}
            />
          )}
          actions={actions}
          anchor={menu.anchor}
          onPick={handlePick}
          onClose={handleCloseMenu}
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
};
const STATE_CLASSES: Record<State, string | undefined> = {
  catalog: undefined,
  waiting: undefined,
  adding: undefined,
  processing: styles.trackStateBusy,
  failed: styles.trackStateFailed,
};
const STATE_KEYS = {
  catalog: 'MusicStateCatalog',
  waiting: 'MusicStateWaiting',
  adding: 'MusicStateAdding',
  processing: 'MusicStateProcessing',
  failed: 'MusicStateFailed',
} as const;

function stateOf(job?: MusicFetchJob): State {
  if (!job) return 'catalog';
  if (job.state === 'failed') return 'failed';
  if (job.state === 'queued') return 'waiting';
  if (job.state === 'downloading' && job.bytesTotal && job.bytesDone >= job.bytesTotal) return 'processing';
  return 'adding';
}

export default memo(MusicCatalogRow);
