import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  kind: string;
  text: TeactNode;
  aside?: string;
  isMono?: boolean;
  onEdit: NoneToVoidFunction;
};

// Parvane (доски `HealthSleep`, `HealthWeight`, `RpHealth`): «Цель» подробного экрана на телефоне — одной строкой:
// подпись мелко, под ней значение, справа длительность и карандаш
const HealthGoalRow = ({
  kind, text, aside, isMono, onEdit,
}: OwnProps) => {
  const lang = useLang();

  return (
    <section className={buildClassName(kit.card, styles.goalRow)} data-health-goal-card={kind}>
      <div className={buildClassName(kit.grow, styles.goalRowText)}>
        <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthGoalLabel')}</div>
        <div className={isMono ? styles.goalRowMono : undefined} data-health-goal-text>{text}</div>
      </div>
      {aside && <span className={buildClassName(kit.mono, kit.muted, kit.small)}>{aside}</span>}
      <button
        type="button"
        className={kit.ib}
        aria-label={lang('HealthGoalChange')}
        data-health-goal-edit={kind}
        onClick={onEdit}
      >
        <ParvaneIcon name="pen" isSmall />
      </button>
    </section>
  );
};

export default memo(HealthGoalRow);
