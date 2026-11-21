import { memo, useEffect } from '../../../../lib/teact/teact';

import type { MusicFetchJob, MusicInfo } from '../../../../api/parvane/musicApi';

import { callMusic, playTracks } from '../musicPlayer';
import { goBackMusic } from '../musicView';
import { getFetchJobs, refreshFetchJobs, retryFetchJob } from './musicFetch';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PvEmpty from '../../notes/PvEmpty';
import MusicSectionHead from '../MusicSectionHead';
import { formatMusicSize } from '../MusicSize';
import MusicFetchJobLine from './MusicFetchJobLine';
import MusicUploadFiles from './MusicUploadFiles';

import musicStyles from '../Music.module.scss';
import styles from './MusicFetch.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
};

// Parvane (spec 041, доска `ZpMusicX` «Загрузки на сервер»): все задачи пользователя — «Найти и скачать» и свои файлы,
// идущие и законченные за последний час: точка состояния, ход, место в очереди, «Повторить», «Убрать», «Слушать».
// Скачивание выключено администратором — одна строка; свои файлы можно загружать отсюда же
const MusicUploadsView = ({ info, isPhone }: OwnProps) => {
  const lang = useLang();
  const jobs = useDerivedState(getFetchJobs);

  useEffect(() => {
    void refreshFetchJobs();
  }, []);

  const handlePlay = useLastCallback(async (trackId: string) => {
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: [trackId] }).catch(() => []);
    if (tracks.length) playTracks(tracks.filter(Boolean), 0, { source: { kind: 'home' } });
  });
  const handleRetry = useLastCallback((job: MusicFetchJob) => void retryFetchJob(job));

  return (
    <div className={musicStyles.view} data-music-uploads>
      <MusicSectionHead
        title={lang('MusicFetchUploadsTitle')}
        subtitle={info.addPerDay ? (
          <span data-music-usage>
            {lang('MusicAddedUsage', {
              today: info.addedToday,
              perDay: info.addPerDay,
              used: formatMusicSize(lang, info.usedBytes),
              quota: formatMusicSize(lang, info.quotaBytes),
            })}
          </span>
        ) : undefined}
        actions={<MusicUploadFiles isCompact canDropOnWindow />}
        barTitle={lang('MusicFetchUploadsTitle')}
        isPhone={isPhone}
        onBack={goBackMusic}
      />
      {!info.isFetchEnabled && (
        <div className={styles.note} data-fetch-disabled>{lang('MusicFetchDisabledByAdmin')}</div>
      )}
      {!jobs.length && <PvEmpty text={lang('MusicFetchUploadsEmpty')} data-music-empty="uploads" />}
      {Boolean(jobs.length) && (
        <div className={styles.list} data-fetch-jobs>
          {jobs.map((job) => (
            <MusicFetchJobLine key={job.jobId} job={job} isFull onPlay={handlePlay} onRetry={handleRetry} />
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(MusicUploadsView);
