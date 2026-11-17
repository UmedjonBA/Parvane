import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { MusicCatalogTrack, MusicFetchJob } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  catalogKey, chooseFetchCandidate, getFetchJobs, refreshFetchJobs, startFetch,
} from './musicFetch';
import { formatTrackTime } from './musicFormat';
import { callMusic } from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  query: string;
  // Трек появился в библиотеке: его можно сыграть
  onPlayLibraryTrack: (trackId: string) => void;
};

const FAILURE_KEYS = {
  notFound: 'MusicFetchNotFound',
  source: 'MusicFetchSourceFailed',
  library: 'MusicFetchLibraryPending',
  limit: 'MusicFetchNoSpace',
} as const;
const SOURCE_KEYS = {
  youtube: 'MusicSourceYoutube',
  youtube_reupload: 'MusicSourceReupload',
  soundcloud: 'MusicSourceSoundcloud',
} as const;

// Parvane (spec 039, этап B): блок «Найти в сети» под результатами поиска по библиотеке. Строки — эталоны
// треков из каталога; «Скачать» запускает на сервере поиск файла в источниках и сверку с эталоном. Уверенное
// совпадение качается само, иначе сервер присылает кандидатов — пользователь выбирает файл
const MusicFetch = ({ query, onPlayLibraryTrack }: OwnProps) => {
  const lang = useLang();
  const jobs = useDerivedState(getFetchJobs);
  const [tracks, setTracks] = useState<MusicCatalogTrack[]>();
  const [isFailed, setIsFailed] = useState(false);
  const [notice, setNotice] = useState<'limit' | 'failed'>();
  const requestIdRef = useRef(0);

  useEffect(() => {
    const id = ++requestIdRef.current;
    setTracks(undefined);
    setIsFailed(false);
    setNotice(undefined);
    void callMusic('parvaneMusicFetchCatalog', { query }).then((found) => {
      if (id === requestIdRef.current) setTracks(found);
    }).catch(() => {
      if (id === requestIdRef.current) setIsFailed(true);
    });
    void refreshFetchJobs();
  }, [query]);

  const handleDownload = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const track = tracks?.[Number(e.currentTarget.dataset.index)];
    if (!track) return;
    const result = await startFetch(track);
    setNotice(result === 'ok' ? undefined : result);
  });

  const handleChoose = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void chooseFetchCandidate(e.currentTarget.dataset.job!, e.currentTarget.dataset.candidate!);
  });

  const handlePlay = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPlayLibraryTrack(e.currentTarget.dataset.libraryTrack!);
  });

  function renderAction(track: MusicCatalogTrack, index: number, job?: MusicFetchJob) {
    const libraryId = job?.state === 'done' ? job.trackId : track.libraryTrackId;
    if (libraryId) {
      return (
        <button type="button" className={kit.btn} data-library-track={libraryId} data-fetch-play onClick={handlePlay}>
          {lang('MusicFetchInLibrary')}
        </button>
      );
    }
    if (job?.state === 'searching') {
      return <span className={kit.muted} data-fetch-state="searching">{lang('MusicFetchSearching')}</span>;
    }
    if (job?.state === 'downloading') {
      return <span className={kit.muted} data-fetch-state="downloading">{lang('MusicFetchDownloading')}</span>;
    }
    return (
      <button
        type="button"
        className={buildClassName(kit.btn, kit.btnAcc)}
        data-index={index}
        data-fetch-download
        onClick={handleDownload}
      >
        {lang(job?.state === 'failed' ? 'MusicFetchRetry' : 'MusicFetchDownload')}
      </button>
    );
  }

  function renderCandidates(job: MusicFetchJob) {
    return (
      <ul className={styles.candidates} data-fetch-candidates>
        <li className={buildClassName(kit.muted, kit.small)}>{lang('MusicFetchChoose')}</li>
        {job.candidates.map((candidate) => {
          const sourceKey = SOURCE_KEYS[candidate.source as keyof typeof SOURCE_KEYS];
          return (
            <li key={candidate.id} className={styles.candidate}>
              <span className={styles.trackText}>
                <span className={styles.trackTitle}>{candidate.title}</span>
                <span className={buildClassName(kit.muted, kit.small)}>
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
              <button
                type="button"
                className={kit.btn}
                data-job={job.jobId}
                data-candidate={candidate.id}
                onClick={handleChoose}
              >
                {lang('MusicFetchTakeThis')}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className={styles.fetch} data-music-fetch>
      <div className={kit.caps}>{lang('MusicFetchTitle')}</div>
      {notice && (
        <div className={styles.error} role="alert" data-fetch-notice={notice}>
          {lang(notice === 'limit' ? 'MusicFetchLimit' : 'MusicFetchStartFailed')}
        </div>
      )}
      {isFailed && <div className={styles.error} role="alert">{lang('MusicFetchUnavailable')}</div>}
      {!tracks && !isFailed && <div className={kit.muted}>{lang('MusicFetchLooking')}</div>}
      {tracks && !tracks.length && <div className={kit.muted} data-fetch-empty>{lang('MusicFetchNothing')}</div>}
      {Boolean(tracks?.length) && (
        <ul className={styles.tracks}>
          {tracks.map((track, index) => {
            const job = jobs.find((item) => catalogKey(item.track) === catalogKey(track));
            return (
              <li key={catalogKey(track)} className={styles.fetchRow} data-fetch-track={track.title}>
                <div className={styles.fetchLine}>
                  <span className={styles.trackText}>
                    <span className={styles.trackTitle}>{track.title}</span>
                    <span className={buildClassName(kit.muted, kit.small, styles.trackArtist)}>
                      {[track.artist, track.album].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={buildClassName(kit.mono, kit.muted, kit.small)}>
                    {formatTrackTime(track.durationSecs)}
                  </span>
                  {renderAction(track, index, job)}
                </div>
                {job?.state === 'failed' && (
                  <div className={styles.error} data-fetch-state="failed">
                    {lang(FAILURE_KEYS[job.failure || 'source'])}
                  </div>
                )}
                {job?.state === 'choice' && renderCandidates(job)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default memo(MusicFetch);
