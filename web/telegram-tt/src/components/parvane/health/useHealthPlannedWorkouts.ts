import { useEffect, useMemo } from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { PlannedWorkout } from '../planner/plannerTools';

import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, loadPlanner } from '../planner/plannerStore';
import { getPlannedWorkouts } from '../planner/plannerTools';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useParvaneModules from '../../../hooks/useParvaneModules';

const MINUTES_IN_HOUR = 60;
const NO_WORKOUTS: PlannedWorkout[] = [];

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Тренировки, запланированные в «Плане», для «Активности» (spec 041 E1, доска `XdHealth`): что считается
// тренировкой, решает движок (`plannerWorkouts`). Модуль «План» выключен — список пуст
export default function useHealthPlannedWorkouts() {
  const { enabled } = useParvaneModules();
  const isPlanOn = enabled.includes('plan');
  const userId = useSelector(selectCurrentUserId);
  const state = useDerivedState(getPlannerState);

  useEffect(() => {
    if (isPlanOn) void loadPlanner(userId);
  }, [isPlanOn, userId]);

  return useMemo(() => {
    if (!isPlanOn) return NO_WORKOUTS;
    const now = new Date();
    try {
      return getPlannedWorkouts(state, toDayKey(now), now.getHours() * MINUTES_IN_HOUR + now.getMinutes());
    } catch (err) {
      // Движок ещё не поднялся
      return NO_WORKOUTS;
    }
  }, [isPlanOn, state]);
}
