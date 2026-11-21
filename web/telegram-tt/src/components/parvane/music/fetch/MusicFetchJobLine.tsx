import { memo } from '../../../../lib/teact/teact';

import type { MusicFetchJob } from '../../../../api/parvane/musicApi';

import buildClassName from '../../../../util/buildClassName';
import { formatTrackTime } from '../musicFormat';
import { cancelFetchJob, chooseFetchCandidate, getJobPercent } from './musicFetch';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import kit from '../../notes/PvKit.module.scss';
import styles from './MusicFetch.module.scss';

type OwnProps = {
  job: MusicFetchJob;
  // Строка экрана «Загрузки на сервер»: название задачи и точка состояния; в строке каталога — только ход
  isFull?: boolean;
  onPlay?: (trackId: string) => void;
  onRetry?: (job: MusicFetchJob) => void;
};

const BYTES_IN_MB = 1024 * 1024;
const SOURCE_KEYS = {
  youtube: 'MusicSourceYoutube',
  youtube_reupload: 'MusicSourceReupload',
  soundcloud: 'MusicSourceSoundcloud',
} as const;
const DOT_CLASSES = {
  queued: styles.dotActive,
  searching: styles.dotActive,
  downloading: styles.dotActive,
  choice: styles.dotChoice,
  done: styles.dotDone,
  failed: styles.dotFailed,
} as const;

// Parvane (spec 041, доски `MusicSearch`, `DeskMusicMore`, `ZpMusicX`): задача «Найти и скачать» либо свой файл —
// ход в процентах с полоской и байтами, место в очереди сервера, отмена, причина отказа словами сервера,
// «Повторить» / «Убрать», «✓ Добавлен в библиотеку · Слушать», выбор файла при спорном совпадении
const MusicFetchJobLine = ({
  job, isFull, onPlay, onRetry,
}: OwnProps) => {
  const lang = useLang();
  const percent = getJobPercent(job);
  const isActive = job.state === 'queued' || job.state === 'searching' || job.state === 'downloading';

  const handleCancel = useLastCallback(() => {
    void cancelFetchJob(job.jobId);
  });
  const handleRetry = useLastCallback(() => onRetry?.(job));
  const handlePlay = useLastCallback(() => onPlay?.(job.trackId!));
  const handleChoose = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void chooseFetchCandidate(job.jobId, e.currentTarget.dataset.candidate!);
  });

  function formatMegabytes(bytes: number) {
    return new Intl.NumberFormat(lang.code, { maximumFractionDigits: 1, minimumFractionDigits: 1 })
      .format(bytes / BYTES_IN_MB);
  }

  function renderState() {
    switch (job.state) {
      case 'queued':
        return job.queueAhead
          ? lang('MusicFetchQueuedAhead', { count: job.queueAhead }, { pluralValue: job.queueAhead })
          : lang('MusicFetchQueued');
      case 'searching':
        return lang(job.query && !job.track.title ? 'MusicFetchPickingReference' : 'MusicFetchSearching');
      case 'downloading': {
        const who = lang(job.uploadName ? 'MusicUploadSending' : 'MusicFetchServerDownloading');
        if (!job.bytesTotal) return job.bytesDone ? `${who} · ${formatMegabytes(job.bytesDone)}` : who;
        return `${who} · ${lang('MusicFetchBytes', {
          done: formatMegabytes(job.bytesDone), total: formatMegabytes(job.bytesTotal),
        })}`;
      }
      case 'choice':
        return lang('MusicFetchChoose');
      case 'done':
        return lang('MusicFetchAdded');
      default:
        return renderFailure();
    }
  }

  function renderFailure() {
    if (job.failureDetail) return lang('MusicFetchServerCannot', { reason: job.failureDetail });
    switch (job.failure) {
      case 'notFound': return lang('MusicFetchNotFoundAnywhere');
      case 'limit': return lang('MusicFetchNoSpace');
      case 'library': return lang('MusicFetchLibraryPending');
      case 'format': return lang('MusicUploadNotAudio');
      case 'duplicate': return lang('MusicUploadDuplicate');
      default: return lang('MusicFetchSourceDown');
    }
  }

  function renderActions() {
    if (isActive) {
      return (
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicFetchCancel')}
          title={lang('MusicFetchCancel')}
          data-fetch-cancel
          onClick={handleCancel}
        >
          ✕
        </button>
      );
    }
    if (job.trackId && (job.state === 'done' || job.failure === 'duplicate') && onPlay) {
      return (
        <button type="button" className={kit.btn} data-fetch-play data-library-track={job.trackId} onClick={handlePlay}>
          {lang('MusicFetchListen')}
        </button>
      );
    }
    if (job.state !== 'failed' || !isFull) return undefined;
    const canRetry = Boolean(onRetry) && !job.uploadName && (job.failure === 'source' || job.failure === 'library');
    return (
      <>
        {canRetry && (
          <button type="button" className={kit.btn} data-fetch-retry onClick={handleRetry}>
            {lang('MusicFetchRetry')}
          </button>
        )}
        <button type="button" className={kit.btnGhost} data-fetch-remove onClick={handleCancel}>
          {lang('MusicFetchRemove')}
        </button>
      </>
    );
  }

  const title = job.uploadName || job.track.title || job.query || '';
  const subtitle = job.track.title && !job.uploadName ? job.track.artist : undefined;
  return (
    <div
      className={styles.row}
      data-fetch-job={job.jobId}
      data-fetch-state={job.state}
      data-fetch-failure={job.failure}
    >
      <div className={styles.line}>
        {isFull && <span className={buildClassName(styles.dot, DOT_CLASSES[job.state])} aria-hidden />}
        <span className={styles.text}>
          {isFull && (
            <span className={styles.title}>{subtitle ? `${title} · ${subtitle}` : title}</span>
          )}
          <span
            className={buildClassName(styles.sub, job.state === 'failed' && styles.subFailed)}
            role={job.state === 'failed' ? 'alert' : undefined}
          >
            {renderState()}
          </span>
        </span>
        {job.state === 'downloading' && percent !== undefined && (
          <span className={styles.percent} data-fetch-percent={percent}>{`${percent}%`}</span>
        )}
        {job.state === 'done' && !isFull && <span className={styles.added}>{lang('MusicFetchAddedMark')}</span>}
        {renderActions()}
      </div>
      {job.state === 'downloading' && percent !== undefined && (
        <div className={styles.bar} aria-hidden>
          <div className={styles.barFill} style={`width: ${percent}%`} />
        </div>
      )}
      {job.state === 'choice' && (
        <ul className={styles.candidates} data-fetch-candidates>
          {job.candidates.map((candidate) => {
            const sourceKey = SOURCE_KEYS[candidate.source as keyof typeof SOURCE_KEYS];
            return (
              <li key={candidate.id} className={styles.candidate}>
                <span className={styles.text}>
                  <span className={styles.title}>{candidate.title}</span>
                  <span className={styles.sub}>
                    {[
                      sourceKey ? lang(sourceKey) : candidate.source,
                      candidate.uploader,
                      formatTrackTime(candidate.durationSecs),
                      candidate.uploaded,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {candidate.isTrustedOriginal && (
                  <span className={styles.mark} data-fetch-trusted>{lang('MusicFetchUncensored')}</span>
                )}
                <button type="button" className={kit.btn} data-candidate={candidate.id} onClick={handleChoose}>
                  {lang('MusicFetchTakeThis')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default memo(MusicFetchJobLine);
