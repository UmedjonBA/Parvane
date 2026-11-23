import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { getFetchJobs, getJobPercent, isJobActive } from './fetch/musicFetch';
import { openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './MusicUploadStatus.module.scss';

type OwnProps = {
  // Телефон: полоса над мини-плеером «Добавляем на сервер N трека · 62%»; компьютер — чип «Добавляем N»
  isPhone?: boolean;
};

const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

// Parvane (макет «Музыки» 23 ноя, доски `MusicHome`, `DeskMusic`): сколько треков сейчас добавляется на сервер —
// только пока что-то добавляется. Кольцо заполняется общим ходом загрузки; нажатие — «Загрузки на сервер»
const MusicUploadStatus = ({ isPhone }: OwnProps) => {
  const lang = useLang();
  const jobs = useDerivedState(getFetchJobs);
  const active = jobs.filter(isJobActive);

  const handleOpen = useLastCallback(() => openMusicView({ kind: 'uploads' }));

  if (!active.length) return undefined;

  const percents = active.map(getJobPercent).filter((value): value is number => value !== undefined);
  const percent = percents.length ? Math.round(percents.reduce((sum, value) => sum + value, 0) / active.length) : 0;
  const label = isPhone
    ? lang('MusicUploadingBar', { count: active.length }, { pluralValue: active.length })
    : lang('MusicUploadingChip', { count: active.length });

  return (
    <button
      type="button"
      className={buildClassName(styles.root, isPhone ? styles.bar : styles.chip)}
      role="status"
      aria-label={lang('MusicUploadingLabel', { count: active.length, percent })}
      data-music-uploading={active.length}
      onClick={handleOpen}
    >
      <svg className={styles.ring} viewBox="0 0 16 16" aria-hidden>
        <circle className={styles.ringTrack} cx="8" cy="8" r={RING_RADIUS} />
        <circle
          className={styles.ringFill}
          cx="8"
          cy="8"
          r={RING_RADIUS}
          stroke-dasharray={`${(RING_LENGTH * Math.max(percent, 8)) / 100} ${RING_LENGTH}`}
        />
      </svg>
      <span className={styles.label}>{label}</span>
      {isPhone && <span className={styles.percent}>{`${percent}%`}</span>}
    </button>
  );
};

export default memo(MusicUploadStatus);
