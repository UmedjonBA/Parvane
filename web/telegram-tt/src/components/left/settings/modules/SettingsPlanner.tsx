import { memo, useEffect } from '../../../../lib/teact/teact';

import type { GlobalState } from '../../../../global/types';

import buildClassName from '../../../../util/buildClassName';
import { requestPlannerImport } from '../../../../util/parvaneSection';
import {
  getIsPlannerLoaded, getPlannerNotice, getPlannerState, loadPlanner,
} from '../../../parvane/planner/plannerStore';

import useSelector from '../../../../hooks/data/useSelector';
import useDerivedState from '../../../../hooks/useDerivedState';
import useHistoryBack from '../../../../hooks/useHistoryBack';
import useWindowSize from '../../../../hooks/window/useWindowSize';

import PvLoading from '../../../parvane/notes/PvLoading';
import PlannerSettings from '../../../parvane/planner/PlannerSettings';

import styles from './SettingsModulePage.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

// Ширина, до которой раскладка — телефон (как у «Плана», `Planner.tsx`)
const NARROW_WIDTH = 925;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Parvane (spec 041, доски `RdPlanSet`, `PhModSettings`): «Профиль → Модули / План». «План» загружается сам, если
// раздел ещё не открывали; уведомления о сохранении — строкой внизу страницы
const SettingsPlanner = ({ isActive, onReset }: OwnProps) => {
  const currentUserId = useSelector(selectCurrentUserId);
  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const notice = useDerivedState(getPlannerNotice);
  const { width } = useWindowSize();
  const isNarrow = width <= NARROW_WIDTH;

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    void loadPlanner(currentUserId);
  }, [currentUserId]);

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.root)} data-settings-page="plan">
      {isLoaded ? (
        <PlannerSettings
          state={state}
          userId={currentUserId}
          isNarrow={isNarrow}
          onOpenImport={isNarrow ? requestPlannerImport : undefined}
        />
      ) : (
        <PvLoading />
      )}
      {notice && <div className={styles.notice} role="status">{notice.text}</div>}
    </div>
  );
};

export default memo(SettingsPlanner);
