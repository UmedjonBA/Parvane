import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

// Объём правки экземпляра ряда (spec 011, FR-004): только этот день, с этого дня и далее, весь ряд
export type PlannerSeriesScope = 'one' | 'following' | 'all';

type OwnProps = {
  title: string;
  onChoose: (scope: PlannerSeriesScope) => void;
  onCancel: NoneToVoidFunction;
};

const PlannerSeriesPrompt = ({ title, onChoose, onCancel }: OwnProps) => {
  const lang = useLang();

  const handleOne = useLastCallback(() => onChoose('one'));
  const handleFollowing = useLastCallback(() => onChoose('following'));
  const handleAll = useLastCallback(() => onChoose('all'));

  return (
    <div className={styles.seriesPrompt} role="group" aria-label={title}>
      <p className={styles.seriesTitle}>{title}</p>
      <button type="button" className={buildClassName(styles.btn, styles.btnWide)} onClick={handleOne}>
        {lang('PlannerSeriesOnlyThis')}
      </button>
      <button type="button" className={buildClassName(styles.btn, styles.btnWide)} onClick={handleFollowing}>
        {lang('PlannerSeriesFollowing')}
      </button>
      <button type="button" className={buildClassName(styles.btn, styles.btnWide)} onClick={handleAll}>
        {lang('PlannerSeriesAll')}
      </button>
      <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onCancel}>
        {lang('Cancel')}
      </button>
    </div>
  );
};

export default memo(PlannerSeriesPrompt);
