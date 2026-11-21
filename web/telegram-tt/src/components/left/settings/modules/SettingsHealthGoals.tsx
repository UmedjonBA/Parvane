import { memo } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';

import useHistoryBack from '../../../../hooks/useHistoryBack';

import HealthGoalsScreen from '../../../parvane/health/HealthGoalsScreen';

import styles from './SettingsModulePage.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

// Parvane (spec 041, доски `RdPlanSet`, `PhModSettings`): «Профиль → Модули / Здоровье — Цели здоровья»
const SettingsHealthGoals = ({ isActive, onReset }: OwnProps) => {
  useHistoryBack({ isActive, onBack: onReset });

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.root)} data-settings-page="health">
      <HealthGoalsScreen />
    </div>
  );
};

export default memo(SettingsHealthGoals);
