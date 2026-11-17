import type { HealthDays } from '../health/healthTypes';
import type {
  PlannerGoalValues, PlannerHealthRecord, PlannerMeal, PlannerNutritionDay, PlannerState,
} from './plannerModel';

import { PLANNER_MEALS, toTime } from './plannerModel';

// Parvane (spec 041 B4): здоровье в календаре «Плана» — из модуля «Здоровье». Сон, еда и тренировки дня
// приходят из движка (`healthDays`) и подставляются в состояние, которое экраны «Плана» читают: слои «Сон» и
// «Еда», карточки «Сегодня», бюджет дня. Подстановка — только на чтение: правки «Плана» идут от его собственного
// состояния, записи здоровья «План» не хранит и не пишет

const MINUTES_IN_DAY = 1440;
const GOAL_TOLERANCE_SHARE = 0.1;
const NUTRIENT_GOALS = ['kcal', 'protein', 'fat', 'carbs'] as const;

function goalsOf(goals: Record<string, number>): PlannerGoalValues {
  const values: PlannerGoalValues = {};
  NUTRIENT_GOALS.forEach((metric) => {
    const target = goals[metric];
    if (target) values[metric] = { target, tolerance: Math.round(target * GOAL_TOLERANCE_SHARE) };
  });
  if (goals.water) values.water = { target: goals.water, tolerance: Math.round(goals.water * GOAL_TOLERANCE_SHARE) };
  return values;
}

/** Состояние «Плана» со здоровьем из модуля «Здоровье»; дней ещё нет — здоровье пустое. */
export function withHealthDays(state: PlannerState, source: HealthDays | undefined): PlannerState {
  const health: PlannerHealthRecord[] = [];
  const nutrition: Record<string, PlannerNutritionDay> = {};
  (source?.days || []).forEach(({
    day, closed: isClosed, sleeps, foods, workouts,
  }) => {
    sleeps.forEach((sleep) => health.push({
      id: sleep.id,
      day,
      kind: 'sleep',
      time: sleep.bedMin === undefined ? undefined : toTime(sleep.bedMin),
      endTime: sleep.wakeMin === undefined ? undefined : toTime(sleep.wakeMin),
      value: sleep.minutes,
    }));
    workouts.forEach((workout) => health.push({
      id: workout.id,
      day,
      kind: 'workout',
      time: toTime(workout.minute),
      value: workout.minutes,
      value2: workout.parts.km,
      name: workout.name || undefined,
    }));
    if (!foods.length && !isClosed) return;
    nutrition[day] = {
      isComplete: isClosed,
      entries: foods.map((food) => ({
        id: food.id,
        name: food.name,
        meal: PLANNER_MEALS.includes(food.tag as PlannerMeal) ? food.tag as PlannerMeal : 'other',
        kcal: food.kcal,
        protein: food.parts.protein,
        fat: food.parts.fat,
        carbs: food.parts.carbs,
        fiber: food.parts.fiber,
        grams: food.parts.grams,
        time: toTime(food.minute),
      })),
    };
  });
  const goals = source?.goals || {};
  const bed = goals.sleep_bed;
  const wake = goals.sleep_wake;
  const sleepMinutes = bed !== undefined && wake !== undefined
    ? (((wake - bed) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY : undefined;
  return {
    ...state,
    health,
    nutrition,
    goals: goalsOf(goals),
    goalPeriods: [],
    healthGoals: {
      sleepMinutes: sleepMinutes || undefined,
      bedtime: bed,
      wakeTime: wake,
      weight: goals.weight,
      steps: goals.steps,
      activeMinutes: goals.active_min,
    },
  };
}
