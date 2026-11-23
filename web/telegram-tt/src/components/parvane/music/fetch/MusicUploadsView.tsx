import {
  memo, useEffect, useLayoutEffect, useState,
} from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { MusicFetchJob, MusicInfo } from '../../../../api/parvane/musicApi';

import buildClassName from '../../../../util/buildClassName';
import { formatTrackTime } from '../musicFormat';
import {
  callMusic, loadMusicInfo, playTracks, setTrackStarred,
} from '../musicPlayer';
import { getUploadsIntent, goBackMusic } from '../musicView';
import {
  cancelFetchJob, getFetchJobs, getJobPercent, isJobActive, putJob, refreshFetchJobs, retryFetchJob,
} from './musicFetch';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ParvaneIcon from '../../../main/ParvaneIcon';
import PvSheet from '../../notes/PvSheet';
import MusicCover from '../MusicCover';
import MusicSectionHead from '../MusicSectionHead';
import { formatMusicSize } from '../MusicSize';
import MusicFetchJobLine from './MusicFetchJobLine';
import MusicUploadFiles from './MusicUploadFiles';

import styles from './MusicUploads.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
};

// Причина отказа без слов сервера — по виду отказа
const FAILURE_KEYS = {
  notFound: 'MusicFetchNotFoundAnywhere',
  limit: 'MusicFetchNoSpace',
  library: 'MusicFetchLibraryPending',
  format: 'MusicUploadNotAudio',
  duplicate: 'MusicUploadDuplicate',
} as const;

const LINK_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com)\//i;
const MINUTE_MS = 60_000;

// Parvane (макет «Музыки» 23 ноя, доски `RpMusicB`, `RdMusic-01`): «Загрузки на сервер · сегодня 18 из 50» —
// «Сейчас» (идёт, ждёт очереди), «Не получилось» с «Повторить», «Готово» с «Очистить». Трек уже на сервере —
// строка с выбором «В Любимое / Добавить [v2]» (телефон — окном «Этот трек уже на сервере»). «Вставить ссылку» —
// поле на компьютере и шторка на телефоне, «Свои файлы» — выбор файлов; внизу — лимиты, их задаёт администратор
const MusicUploadsView = ({ info, isPhone }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const jobs = useDerivedState(getFetchJobs);
  const intent = useDerivedState(getUploadsIntent);
  const [link, setLink] = useState('');
  const [isStar, setIsStar] = useState(false);
  const [isLinkOpen, setIsLinkOpen] = useState(false);
  const [fileToken, setFileToken] = useState(0);
  const [decided, setDecided] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refreshFetchJobs();
  }, []);

  // «+ → Вставить ссылку / Загрузить файл» открывает своё
  useLayoutEffect(() => {
    if (!intent) return;
    if (intent.kind === 'link') setIsLinkOpen(true);
    else setFileToken(intent.token);
  }, [intent]);

  const active = jobs.filter((job) => isJobActive(job) || job.state === 'choice');
  const failed = jobs.filter((job) => job.state === 'failed');
  const done = jobs.filter((job) => job.state === 'done');
  // Трек уже на сервере, и «Любимое» не просили: человек решает, что сделать
  const asking = done.filter((job) => job.isExisting && !job.isStar && !decided.has(job.jobId));
  const isLinkValid = LINK_HOSTS.test(link.trim());
  const isLimitReached = info.addPerDay > 0 && info.addedToday >= info.addPerDay;

  const handleLink = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setLink(e.currentTarget.value));
  const handleOpenLink = useLastCallback(() => setIsLinkOpen(true));
  const handleCloseLink = useLastCallback(() => setIsLinkOpen(false));
  const handleToggleStar = useLastCallback(() => setIsStar(!isStar));
  const handleAddLink = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const url = link.trim();
    if (!LINK_HOSTS.test(url)) return;
    const job = await callMusic('parvaneMusicFetchLink', { url, isStar }).catch((err: unknown) => {
      const isLimit = String(err).includes('ERROR_CODE_LIMIT');
      showNotification({ message: lang(isLimit ? 'MusicFetchLimit' : 'MusicFetchFailedShort') });
      return undefined;
    });
    if (!job) return;
    putJob(job);
    setLink('');
    setIsLinkOpen(false);
    void loadMusicInfo();
  });
  const handleRetry = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const job = jobs.find((item) => item.jobId === e.currentTarget.dataset.job);
    if (job) void retryFetchJob(job);
  });
  const handleRemove = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void cancelFetchJob(e.currentTarget.dataset.job!);
  });
  const handleClearDone = useLastCallback(() => {
    done.forEach((job) => void cancelFetchJob(job.jobId));
  });
  const handlePlay = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const trackId = e.currentTarget.dataset.track;
    if (!trackId) return;
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: [trackId] }).catch(() => []);
    if (tracks.length) playTracks(tracks.filter(Boolean), 0, { source: { kind: 'home' } });
  });
  const handlePlayChoice = useLastCallback(async (trackId: string) => {
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: [trackId] }).catch(() => []);
    if (tracks.length) playTracks(tracks.filter(Boolean), 0, { source: { kind: 'home' } });
  });
  const handleRetryChoice = useLastCallback((job: MusicFetchJob) => void retryFetchJob(job));
  // «Этот трек уже на сервере»: в «Любимое» либо вторая версия
  const handleExistingStar = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const job = jobs.find((item) => item.jobId === e.currentTarget.dataset.job);
    if (!job?.trackId) return;
    setDecided((previous) => new Set(previous).add(job.jobId));
    const [track] = await callMusic('parvaneMusicTracks', { trackIds: [job.trackId] }).catch(() => []);
    if (track) void setTrackStarred(track, true);
    showNotification({ message: lang('MusicAddedToFavorites') });
  });
  const handleExistingVersion = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const job = jobs.find((item) => item.jobId === e.currentTarget.dataset.job);
    if (!job) return;
    setDecided((previous) => new Set(previous).add(job.jobId));
    const next = job.url
      ? await callMusic('parvaneMusicFetchLink', { url: job.url, asVersion: true }).catch(() => undefined)
      : undefined;
    if (next) putJob(next);
    else showNotification({ message: lang('MusicFetchFailedShort') });
  });
  const handleExistingDismiss = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.job!;
    setDecided((previous) => new Set(previous).add(id));
  });

  function renderStatus(job: MusicFetchJob) {
    const name = job.uploadName || job.track.title || job.query || job.url || '';
    const artist = job.uploadName ? lang('MusicOwnFileShort') : job.track.artist;
    if (job.state === 'failed') {
      return {
        icon: 'warn' as const,
        tone: styles.iconFailed,
        name,
        sub: [artist, job.failureDetail || lang(job.failure && job.failure in FAILURE_KEYS
          ? FAILURE_KEYS[job.failure as keyof typeof FAILURE_KEYS] : 'MusicStateFailed')],
      };
    }
    if (job.state === 'queued') {
      return { icon: 'clock' as const, name, sub: [artist, lang('MusicWaitingAhead', { count: job.queueAhead + 1 })] };
    }
    if (job.state === 'done') {
      const minutes = Math.max(1, Math.round((Date.now() - job.updatedMs) / MINUTE_MS));
      const when = lang('MusicAgoMinutes', { count: minutes });
      return {
        name,
        sub: job.isExisting ? [lang(job.isStar ? 'MusicExistingStarred' : 'MusicExistingOnServer')]
          : [artist, job.isStar ? lang('MusicToFavoritesShort') : undefined, when],
      };
    }
    const percent = getJobPercent(job);
    return { ring: true, name, sub: [artist, percent !== undefined ? `${percent}%` : lang('MusicStateAdding')] };
  }

  function renderJob(job: MusicFetchJob) {
    if (job.state === 'choice') {
      return (
        <MusicFetchJobLine key={job.jobId} job={job} isFull onPlay={handlePlayChoice} onRetry={handleRetryChoice} />
      );
    }
    const status = renderStatus(job);
    return (
      <div
        key={job.jobId}
        className={styles.row}
        data-fetch-job={job.state}
        data-fetch-failure={job.state === 'failed' ? job.failure : undefined}
      >
        <MusicCover
          coverUrl={job.track.coverUrl}
          toneId={job.track.ref || job.jobId}
          size={46}
          className={styles.cover}
        />
        <span className={styles.text}>
          <span className={styles.title}>{status.name}</span>
          <span className={styles.sub}>
            {status.ring && <span className={styles.ring} aria-hidden />}
            {status.icon && (
              <ParvaneIcon name={status.icon} isSmall className={buildClassName(styles.icon, status.tone)} />
            )}
            <span className={styles.subText}>{status.sub.filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        {!isPhone && job.track.durationSecs > 0 && job.state === 'done' && (
          <span className={styles.time}>{formatTrackTime(job.track.durationSecs)}</span>
        )}
        {job.state === 'failed' && (
          <button
            type="button"
            className={buildClassName(styles.iconButton, styles.iconFailed)}
            aria-label={lang('MusicRetryNamed', { name: status.name })}
            data-job={job.jobId}
            onClick={handleRetry}
          >
            <ParvaneIcon name="refresh" isSmall />
          </button>
        )}
        {job.state === 'done' && job.trackId && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={lang('MusicListen')}
            data-track={job.trackId}
            onClick={handlePlay}
          >
            <ParvaneIcon name="play" isSmall />
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={lang(isJobActive(job) ? 'MusicFetchCancel' : 'MusicFetchRemove')}
          data-job={job.jobId}
          onClick={handleRemove}
        >
          <ParvaneIcon name="close" isSmall />
        </button>
      </div>
    );
  }

  function renderExisting(job: MusicFetchJob) {
    return (
      <div key={`ask:${job.jobId}`} className={styles.ask} data-fetch-existing={job.jobId}>
        <MusicCover
          coverUrl={job.track.coverUrl}
          toneId={job.track.ref || job.jobId}
          size={40}
          className={styles.cover}
        />
        <span className={styles.text}>
          <span className={styles.title}>
            {lang('MusicExistingTitle', { name: `${job.track.title} · ${job.track.artist}` })}
          </span>
          <span className={styles.sub}>{lang('MusicExistingWhat')}</span>
        </span>
        <button type="button" className={styles.askPrimary} data-job={job.jobId} onClick={handleExistingStar}>
          {lang('MusicToFavoritesQuoted')}
        </button>
        {job.url && (
          <button type="button" className={styles.askSecondary} data-job={job.jobId} onClick={handleExistingVersion}>
            {lang('MusicAddVersion')}
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={lang('Close')}
          data-job={job.jobId}
          onClick={handleExistingDismiss}
        >
          <ParvaneIcon name="close" isSmall />
        </button>
      </div>
    );
  }

  function renderSection(caps: string, list: MusicFetchJob[], action?: TeactAction) {
    if (!list.length) return undefined;
    return (
      <section className={styles.section}>
        <div className={styles.capsRow}>
          <span className={styles.caps}>{caps}</span>
          {action && (
            <button type="button" className={styles.capsAction} onClick={action.onClick}>{action.label}</button>
          )}
        </div>
        {list.map(renderJob)}
      </section>
    );
  }

  const linkForm = (
    <form className={styles.linkForm} onSubmit={handleAddLink}>
      <input
        className={styles.linkInput}
        type="url"
        value={link}
        placeholder={lang('MusicLinkPlaceholder')}
        aria-label={lang('MusicAddLink')}
        data-music-link
        onChange={handleLink}
      />
      <button type="submit" className={styles.linkAdd} disabled={!isLinkValid} data-music-link-add>
        {lang('MusicAddShort')}
      </button>
    </form>
  );
  const firstAsking = isPhone ? asking[0] : undefined;
  const todayText = lang('MusicTodayOf', { done: info.addedToday, limit: info.addPerDay });

  return (
    <div className={styles.root} data-music-uploads>
      <MusicSectionHead
        title={lang('MusicFetchUploadsTitle')}
        barSubtitle={info.addPerDay ? todayText : undefined}
        subtitle={info.addPerDay ? [
          lang('MusicTodayOf', { done: info.addedToday, limit: info.addPerDay }),
          lang('MusicOwnFilesOf', {
            used: formatMusicSize(lang, info.usedBytes), quota: formatMusicSize(lang, info.quotaBytes),
          }),
        ].join(' · ') : undefined}
        isPhone={isPhone}
        barActions={info.isFetchEnabled && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={lang('MusicAddLink')}
            onClick={handleOpenLink}
          >
            <ParvaneIcon name="link" />
          </button>
        )}
        onBack={goBackMusic}
      />
      {!isPhone && (
        <div className={styles.deskTools}>
          {info.isFetchEnabled && linkForm}
          {info.isUploadEnabled && <MusicUploadFiles isCompact canDropOnWindow openToken={fileToken} />}
        </div>
      )}
      {isPhone && info.isUploadEnabled && (
        <div className={styles.hidden}><MusicUploadFiles isCompact openToken={fileToken} /></div>
      )}
      {!info.isFetchEnabled && (
        <div className={styles.note} data-fetch-disabled>{lang('MusicFetchDisabledByAdmin')}</div>
      )}
      {isLimitReached && (
        <div className={styles.limitCard} data-music-limit>
          <div className={styles.limitTitle}>{lang('MusicLimitReached')}</div>
          <div>{lang('MusicLimitReachedText', { done: info.addedToday, limit: info.addPerDay })}</div>
        </div>
      )}
      {!isPhone && asking.map(renderExisting)}
      {!jobs.length && <div className={styles.note} data-music-empty="uploads">{lang('MusicFetchUploadsEmpty')}</div>}
      {renderSection(lang('MusicUploadsNow', { count: active.length }), active)}
      {renderSection(lang('MusicUploadsFailed', { count: failed.length }), failed)}
      {renderSection(lang('MusicUploadsDone', { count: done.length }), done, {
        label: lang('MusicClear'), onClick: handleClearDone,
      })}
      <section className={styles.limits} data-music-limits>
        <div className={styles.limitRow}>
          <span className={styles.limitLabel}>{lang('MusicLimitTracks')}</span>
          <span className={styles.limitValue}>{todayText}</span>
          <span className={styles.bar}>
            <i style={`width: ${info.addPerDay ? Math.min(100, (info.addedToday / info.addPerDay) * 100) : 0}%`} />
          </span>
        </div>
        <div className={styles.limitRow}>
          <span className={styles.limitLabel}>{lang('MusicLimitSpace')}</span>
          <span className={styles.limitValue}>
            {lang('MusicOwnFilesOf', {
              used: formatMusicSize(lang, info.usedBytes), quota: formatMusicSize(lang, info.quotaBytes),
            })}
          </span>
          <span className={styles.bar}>
            <i style={`width: ${info.quotaBytes ? Math.min(100, (info.usedBytes / info.quotaBytes) * 100) : 0}%`} />
          </span>
        </div>
        {info.isUploadEnabled && (
          <div className={styles.limitRow}>
            <span className={styles.limitLabel}>{lang('MusicLimitFile')}</span>
            <span className={styles.limitValue}>
              {lang('MusicUpTo', { size: formatMusicSize(lang, info.uploadMaxBytes) })}
            </span>
          </div>
        )}
        {info.fetchParallel > 0 && (
          <div className={styles.limitRow}>
            <span className={styles.limitLabel}>{lang('MusicLimitParallel')}</span>
            <span className={styles.limitValue}>
              {lang('MusicParallelValue', { count: info.fetchParallel }, { pluralValue: info.fetchParallel })}
            </span>
          </div>
        )}
        <p className={styles.note}>{lang('MusicLimitsByAdmin')}</p>
      </section>
      <PvSheet isOpen={isLinkOpen && Boolean(isPhone)} title={lang('MusicAddLink')} onClose={handleCloseLink}>
        <form className={styles.linkSheet} onSubmit={handleAddLink}>
          <input
            className={styles.linkInput}
            type="url"
            value={link}
            placeholder={lang('MusicLinkPlaceholder')}
            aria-label={lang('MusicAddLink')}
            data-music-link
            onChange={handleLink}
          />
          <button type="button" className={styles.starRow} aria-pressed={isStar} onClick={handleToggleStar}>
            <ParvaneIcon name="plus" isSmall />
            <span className={styles.starLabel}>{lang('MusicAlsoAddTo')}</span>
            <span className={styles.sub}>{lang(isStar ? 'MusicStarred' : 'MusicNowhere')}</span>
          </button>
          <button type="submit" className={styles.linkAdd} disabled={!isLinkValid} data-music-link-add>
            {lang('MusicAddToServer')}
          </button>
        </form>
      </PvSheet>
      {firstAsking && (
        <PvSheet isOpen title={lang('MusicExistingSheetTitle')} onClose={handleExistingDismissFirst}>
          <div className={styles.linkSheet} data-fetch-existing={firstAsking.jobId}>
            <div className={styles.ask}>
              <MusicCover
                coverUrl={firstAsking.track.coverUrl}
                toneId={firstAsking.jobId}
                size={46}
                className={styles.cover}
              />
              <span className={styles.text}>
                <span className={styles.title}>{firstAsking.track.title}</span>
                <span className={styles.sub}>{firstAsking.track.artist}</span>
              </span>
            </div>
            <button type="button" className={styles.linkAdd} data-job={firstAsking.jobId} onClick={handleExistingStar}>
              {lang('MusicJustToFavorites')}
            </button>
            {firstAsking.url && (
              <button
                type="button"
                className={styles.askSecondary}
                data-job={firstAsking.jobId}
                onClick={handleExistingVersion}
              >
                {lang('MusicAddSecondVersion')}
              </button>
            )}
            <p className={styles.note}>{lang('MusicVersionsNote')}</p>
          </div>
        </PvSheet>
      )}
    </div>
  );

  function handleExistingDismissFirst() {
    if (firstAsking) setDecided((previous) => new Set(previous).add(firstAsking.jobId));
  }
};

type TeactAction = { label: string; onClick: NoneToVoidFunction };

export default memo(MusicUploadsView);
