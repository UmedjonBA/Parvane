import { memo } from '../../../lib/teact/teact';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';

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
      <p className={styles.summary}>{title}</p>
      <div className={styles.actions}>
        <Button size="smaller" onClick={handleOne}>{lang('PlannerSeriesOnlyThis')}</Button>
        <Button size="smaller" color="translucent" onClick={handleFollowing}>{lang('PlannerSeriesFollowing')}</Button>
        <Button size="smaller" color="translucent" onClick={handleAll}>{lang('PlannerSeriesAll')}</Button>
        <Button isText size="smaller" onClick={onCancel}>{lang('Cancel')}</Button>
      </div>
    </div>
  );
};

export default memo(PlannerSeriesPrompt);
