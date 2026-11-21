import { memo, useEffect } from '../../../../lib/teact/teact';

import { getMusicInfo } from '../musicPlayer';
import { openMusicView } from '../musicView';
import { getFetchJobs, refreshFetchJobs } from './musicFetch';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ParvaneIcon from '../../../main/ParvaneIcon';
import MusicRecentQueries from './MusicRecentQueries';

import styles from './MusicFetch.module.scss';

type OwnProps = {
  onPick: (query: string) => void;
};

// Parvane (spec 041, доска `ZpMusicX`): поиск «Музыки» с пустым полем — «Загрузки на сервер · N» (задачи есть либо
// можно загрузить свои файлы) и «Недавние запросы»
const MusicSearchStart = ({ onPick }: OwnProps) => {
  const lang = useLang();
  const jobs = useDerivedState(getFetchJobs);
  const info = useDerivedState(getMusicInfo);

  useEffect(() => {
    void refreshFetchJobs();
  }, []);

  const handleUploads = useLastCallback(() => openMusicView({ kind: 'uploads' }));

  return (
    <div className={styles.screen}>
      {(Boolean(jobs.length) || info?.isUploadEnabled) && (
        <button type="button" className={styles.recentItem} data-fetch-uploads onClick={handleUploads}>
          <ParvaneIcon name="upload" isSmall />
          <span className={styles.title}>{lang('MusicFetchUploadsTitle')}</span>
          {Boolean(jobs.length) && <span className={styles.note}>{jobs.length}</span>}
        </button>
      )}
      <MusicRecentQueries onPick={onPick} />
    </div>
  );
};

export default memo(MusicSearchStart);
