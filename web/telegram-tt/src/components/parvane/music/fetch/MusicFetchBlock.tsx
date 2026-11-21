import {
  memo, useEffect, useRef, useState,
} from '../../../../lib/teact/teact';

import type { MusicCatalogTrack, MusicFetchJob } from '../../../../api/parvane/musicApi';

import buildClassName from '../../../../util/buildClassName';
import { formatTrackTime } from '../musicFormat';
import { callMusic, getMusicInfo } from '../musicPlayer';
import { openMusicView } from '../musicView';
import {
  catalogKey, getFetchJobs, refreshFetchJobs, retryFetchJob, startFetch, startFetchByQuery,
} from './musicFetch';
import { rememberQuery } from './musicRecentQueries';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import MusicFetchJobLine from './MusicFetchJobLine';

import kit from '../../notes/PvKit.module.scss';
import styles from './MusicFetch.module.scss';

type OwnProps = {
  query: string;
  // Трек появился в библиотеке: его можно сыграть
  onPlayLibraryTrack: (trackId: string) => void;
};

type Notice = 'limit' | 'duplicate' | 'failed';

const NOTICE_KEYS = {
  limit: 'MusicFetchLimit',
  duplicate: 'MusicFetchAlreadyGoing',
  failed: 'MusicFetchStartFailed',
} as const satisfies Record<Notice, string>;

// Parvane (spec 039 этап B, spec 041 доски `MusicSearch`, `DeskMusicMore`, `ZpMusicX`): блок «Нет на сервере» под
// результатами поиска. Большая кнопка «Найти и скачать «запрос»» — эталон сервер берёт из каталога сам; ниже строки
// каталога с «Найти и скачать» у каждой (уточнение). Ход в процентах, очередь сервера, отмена, выбор файла при
// спорном совпадении, «✓ Добавлен». Скачивание выключено администратором — одна строка вместо блока
const MusicFetchBlock = ({ query, onPlayLibraryTrack }: OwnProps) => {
  const lang = useLang();
  const info = useDerivedState(getMusicInfo);
  const jobs = useDerivedState(getFetchJobs);
  const [tracks, setTracks] = useState<MusicCatalogTrack[]>();
  const [isFailed, setIsFailed] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const requestIdRef = useRef(0);
  const isEnabled = Boolean(info?.isFetchEnabled);

  useEffect(() => {
    if (!isEnabled || !query) return;
    const id = ++requestIdRef.current;
    setTracks(undefined);
    setIsFailed(false);
    setNotice(undefined);
    rememberQuery(query);
    void callMusic('parvaneMusicFetchCatalog', { query }).then((found) => {
      if (id === requestIdRef.current) setTracks(found);
    }).catch(() => {
      if (id === requestIdRef.current) setIsFailed(true);
    });
    void refreshFetchJobs();
  }, [isEnabled, query]);

  const handleByQuery = useLastCallback(async () => {
    const result = await startFetchByQuery(query);
    setNotice(result === 'ok' ? undefined : result);
  });

  const handleDownload = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const track = tracks?.[Number(e.currentTarget.dataset.index)];
    if (!track) return;
    const result = await startFetch(track);
    setNotice(result === 'ok' ? undefined : result);
  });

  const handleRetry = useLastCallback(async (job: MusicFetchJob) => {
    const result = await retryFetchJob(job);
    setNotice(result === 'ok' ? undefined : result);
  });

  const handlePlay = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPlayLibraryTrack(e.currentTarget.dataset.libraryTrack!);
  });

  const handleOpenUploads = useLastCallback(() => openMusicView({ kind: 'uploads' }));

  if (!info) return undefined;
  if (!isEnabled) {
    return (
      <div className={buildClassName(kit.muted, styles.block)} data-fetch-disabled>
        {lang('MusicFetchDisabledByAdmin')}
      </div>
    );
  }

  const queryJob = jobs.find((job) => job.query?.toLowerCase() === query.toLowerCase());

  function renderCatalogAction(track: MusicCatalogTrack, index: number, job?: MusicFetchJob) {
    const libraryId = job?.state === 'done' ? job.trackId : track.libraryTrackId;
    if (libraryId) {
      return (
        <button
          type="button"
          className={kit.btnGhost}
          data-library-track={libraryId}
          data-fetch-play
          onClick={handlePlay}
        >
          {lang('MusicFetchAddedMark')}
        </button>
      );
    }
    if (job && job.state !== 'failed') return undefined;
    return (
      <button type="button" className={kit.btn} data-index={index} data-fetch-download onClick={handleDownload}>
        {lang(job ? 'MusicFetchRetry' : 'MusicFetchFindAndDownload')}
      </button>
    );
  }

  return (
    <section className={styles.block} data-music-fetch>
      <div className={styles.headRow}>
        <div className={buildClassName(kit.caps, kit.grow)}>{lang('MusicFetchTitle')}</div>
        {Boolean(jobs.length) && (
          <button type="button" className={kit.btnGhost} data-fetch-uploads onClick={handleOpenUploads}>
            {lang('MusicFetchUploadsCount', { count: jobs.length }, { pluralValue: jobs.length })}
          </button>
        )}
      </div>
      {queryJob ? (
        <MusicFetchJobLine job={queryJob} isFull onPlay={onPlayLibraryTrack} onRetry={handleRetry} />
      ) : (
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, styles.byQuery)}
          data-fetch-by-query
          onClick={handleByQuery}
        >
          {lang('MusicFetchByQuery', { query })}
        </button>
      )}
      <div className={styles.note}>{lang('MusicFetchByQueryHint')}</div>
      {notice && (
        <div className={styles.error} role="alert" data-fetch-notice={notice}>{lang(NOTICE_KEYS[notice])}</div>
      )}
      {isFailed && <div className={styles.error} role="alert">{lang('MusicFetchUnavailable')}</div>}
      {!tracks && !isFailed && <div className={kit.muted}>{lang('MusicFetchLooking')}</div>}
      {tracks && !tracks.length && <div className={kit.muted} data-fetch-empty>{lang('MusicFetchNothing')}</div>}
      {Boolean(tracks?.length) && (
        <ul className={styles.list}>
          {tracks.map((track, index) => {
            // Задача по запросу уже показана над строками — в строке каталога её не повторять
            const job = jobs.find((item) => !item.uploadName && item.jobId !== queryJob?.jobId
              && catalogKey(item.track) === catalogKey(track));
            return (
              <li key={catalogKey(track)} className={styles.row} data-fetch-track={track.title}>
                <div className={styles.line}>
                  <span className={styles.text}>
                    <span className={styles.title}>{track.title}</span>
                    <span className={styles.sub}>
                      {[track.artist, formatTrackTime(track.durationSecs)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {renderCatalogAction(track, index, job)}
                </div>
                {job && job.state !== 'done' && (
                  <MusicFetchJobLine job={job} onPlay={onPlayLibraryTrack} onRetry={handleRetry} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.note}>{lang('MusicFetchSharedNote')}</div>
    </section>
  );
};

export default memo(MusicFetchBlock);
