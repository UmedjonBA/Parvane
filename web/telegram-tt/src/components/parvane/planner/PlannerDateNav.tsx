import { memo } from '../../../lib/teact/teact';

import { formatDay, formatRelativeDay } from './plannerFormat';

import useLang from '../../../hooks/useLang';

import Icon from '../../common/icons/Icon';

import styles from './Planner.module.scss';

type OwnProps = {
  day: string;
  today: string;
  onPrev: NoneToVoidFunction;
  onNext: NoneToVoidFunction;
  onToday: NoneToVoidFunction;
};

// Шапка дня на «Сегодня» и «Здоровье»: «Сегодня / Завтра / день недели», крупная дата и стрелки дней
const PlannerDateNav = ({
  day, today, onPrev, onNext, onToday,
}: OwnProps) => {
  const lang = useLang();

  return (
    <div className={styles.dateNav}>
      <div className={styles.grow}>
        <div className={styles.dateNavOver}>{formatRelativeDay(lang, day, today)}</div>
        <div className={styles.dateNavBig}>{formatDay(lang, day)}</div>
      </div>
      {day !== today && (
        <button type="button" className={styles.pill} onClick={onToday}>{lang('PlannerJumpToday')}</button>
      )}
      <button type="button" className={styles.ib} aria-label={lang('PlannerPrevPeriod')} onClick={onPrev}>
        <Icon name="previous" />
      </button>
      <button type="button" className={styles.ib} aria-label={lang('PlannerNextPeriod')} onClick={onNext}>
        <Icon name="next" />
      </button>
    </div>
  );
};

export default memo(PlannerDateNav);
