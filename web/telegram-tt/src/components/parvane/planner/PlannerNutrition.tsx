import { memo, useState } from '../../../lib/teact/teact';

import type { LangFn } from '../../../util/localization';
import type {
  PlannerFoodEntry, PlannerGoalMetric, PlannerMeal, PlannerState,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatNumber } from './plannerFormat';
import {
  getNutrientGoal, getNutrientStatus, getNutrientTotal, isDayClosed, isKnownNumber,
  PLANNER_GOAL_METRICS, PLANNER_MEALS, PLANNER_METRICS,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  // Открыть форму записи в левой колонке: без id — новая запись
  onOpenFood: (entryId?: string) => void;
};

const METRIC_KEYS = {
  kcal: 'PlannerMetricKcal',
  protein: 'PlannerMetricProtein',
  fat: 'PlannerMetricFat',
  carbs: 'PlannerMetricCarbs',
  fiber: 'PlannerMetricFiber',
  water: 'PlannerMetricWater',
} as const satisfies Record<PlannerGoalMetric, string>;

const SHORT_KEYS = {
  protein: 'PlannerMetricProteinShort',
  fat: 'PlannerMetricFatShort',
  carbs: 'PlannerMetricCarbsShort',
} as const;

export const MEAL_KEYS = {
  breakfast: 'PlannerMealBreakfast',
  lunch: 'PlannerMealLunch',
  dinner: 'PlannerMealDinner',
  snack: 'PlannerMealSnack',
  other: 'PlannerMealOther',
} as const satisfies Record<PlannerMeal, string>;

const STATUS_KEYS = {
  none: 'PlannerFoodStatusNone',
  nogoal: 'PlannerFoodStatusNoGoal',
  incomplete: 'PlannerFoodStatusIncomplete',
  open: 'PlannerFoodStatusOpen',
  below: 'PlannerFoodStatusBelow',
  above: 'PlannerFoodStatusAbove',
  ok: 'PlannerFoodStatusOk',
} as const;

export function formatMetric(lang: LangFn, metric: PlannerGoalMetric) {
  return lang(METRIC_KEYS[metric]);
}

export function formatMetricUnit(lang: LangFn, metric: PlannerGoalMetric) {
  return lang(metric === 'kcal' ? 'PlannerUnitKcal' : metric === 'water' ? 'PlannerUnitMl' : 'PlannerUnitGram');
}

export function formatFoodStatus(lang: LangFn, state: PlannerState, day: string, metric: PlannerGoalMetric = 'kcal') {
  return lang(STATUS_KEYS[getNutrientStatus(state, day, metric)]);
}

// Дневник питания дня: прогресс по калориям и БЖУ, записи по приёмам пищи, вода
const PlannerNutrition = ({
  state, day, today, onOpenFood,
}: OwnProps) => {
  const lang = useLang();

  const [error, setError] = useState<string>();

  const record = state.nutrition[day] || { entries: [], isComplete: false };
  const isFuture = day > today;
  const isPast = day < today;
  // Прошедший день завершён сам (spec 013), кнопки завершения нет
  const isClosed = isDayClosed(state, day, today);

  // Форма записи открывается левой колонкой «Плана» (как форма задачи), дневник остаётся на месте
  const handleEntryClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenFood(e.currentTarget.dataset.entryId);
  });

  const handleAddClick = useLastCallback(() => {
    onOpenFood();
  });

  const changeDay = useLastCallback((mutate: (target: typeof record) => void, notice: string) => {
    updatePlanner((draft) => {
      draft.nutrition[day] ??= { entries: [], isComplete: false };
      mutate(draft.nutrition[day]);
    }, notice);
  });

  const handleWater = useLastCallback((value: string) => {
    const waterMl = value === '' ? undefined : Number(value);
    if (waterMl !== undefined && !isKnownNumber(waterMl)) return setError(lang('PlannerErrorWater'));
    return changeDay((target) => {
      target.waterMl = waterMl;
      if (!isPast) target.isComplete = false;
    }, lang('PlannerNoticeWaterUpdated'));
  });

  const hasMissingMacros = PLANNER_METRICS.slice(1).some((metric) => getNutrientTotal(state, day, metric).missing);
  const fiber = getNutrientTotal(state, day, 'fiber');

  return (
    <div className={styles.dayList}>
      <div className={styles.nutrients}>
        {PLANNER_GOAL_METRICS.map((metric) => {
          const total = getNutrientTotal(state, day, metric);
          const goal = getNutrientGoal(state, day, metric);
          const status = getNutrientStatus(state, day, metric);
          const shown = total.count ? `${formatNumber(lang, total.value)}${total.missing ? ' + ?' : ''}` : '—';
          return (
            <div key={metric} className={styles.nutrient} data-metric={metric} data-status={status}>
              <div className={styles.nutrientHead}>
                <span>{formatMetric(lang, metric)}</span>
                <span>
                  {shown}
                  <small className={styles.small}>
                    {goal
                      ? ` / ${formatNumber(lang, goal.target)} ${formatMetricUnit(lang, metric)}`
                      : ` ${formatMetricUnit(lang, metric)} · ${lang('PlannerFoodStatusNoGoal')}`}
                  </small>
                </span>
              </div>
              <div
                className={styles.track}
                style={`--planner-progress: ${goal ? Math.min(100, (total.value / goal.target) * 100) : 0}%`}
                aria-hidden="true"
              >
                <span />
              </div>
              {status !== 'none' && status !== 'nogoal' && (
                <span className={styles.small}>{lang(STATUS_KEYS[status])}</span>
              )}
            </div>
          );
        })}
      </div>
      {hasMissingMacros && <p className={styles.small}>{lang('PlannerFoodMissingNote')}</p>}
      {!record.entries.length && (
        <p className={styles.small}>{lang(isFuture ? 'PlannerFoodFutureDay' : 'PlannerFoodEmpty')}</p>
      )}
      {PLANNER_MEALS.map((mealKey) => {
        const entries = record.entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.meal === mealKey);
        if (!entries.length) return undefined;
        const mealKcal = entries.reduce((sum, { entry }) => sum + entry.kcal, 0);
        return (
          <div key={mealKey}>
            <h3 className={buildClassName(styles.group, styles.mealHead)}>
              <span>{lang(MEAL_KEYS[mealKey])}</span>
              <span>{`${formatNumber(lang, mealKcal)} ${lang('PlannerUnitKcal')}`}</span>
            </h3>
            {entries.map(({ entry, index }) => (
              <button
                key={`${index}${entry.name}`}
                type="button"
                className={styles.mealEntry}
                data-entry-id={entry.id}
                aria-label={lang('PlannerAriaEditFood', { name: entry.name })}
                onClick={handleEntryClick}
              >
                <span className={styles.mealEntryTop}>
                  <span className={styles.taskName}>{entry.name}</span>
                  <span>{`${formatNumber(lang, entry.kcal)} ${lang('PlannerUnitKcal')}`}</span>
                </span>
                <span className={styles.small}>{formatMacros(entry)}</span>
              </button>
            ))}
          </div>
        );
      })}
      <Button isText size="smaller" className={styles.inlineAdd} disabled={isFuture} onClick={handleAddClick}>
        {lang('PlannerFoodAdd')}
      </Button>
      <details className={styles.fold}>
        <summary>{lang('PlannerFoodExtra')}</summary>
        <p className={styles.small}>
          {fiber.count
            ? lang('PlannerFoodFiberValue', {
              value: `${formatNumber(lang, fiber.value)}${fiber.missing ? ' + ?' : ''}`,
            })
            : lang('PlannerFoodFiberNone')}
        </p>
        <PlannerField
          label={lang('PlannerFoodWater')}
          type="number"
          value={toInput(record.waterMl)}
          min={0}
          step="any"
          disabled={isFuture}
          onCommit={handleWater}
        />
      </details>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {isClosed && Boolean(record.entries.length) && (
        <p className={styles.small}>
          {lang('PlannerFoodDayResult', { status: formatFoodStatus(lang, state, day) })}
        </p>
      )}
    </div>
  );

  function formatMacros(entry: PlannerFoodEntry) {
    const parts = (['protein', 'fat', 'carbs'] as const).map((metric) => {
      const value = entry[metric];
      return `${lang(SHORT_KEYS[metric])} ${isKnownNumber(value) ? formatNumber(lang, value) : '?'}`;
    });
    if (entry.grams) parts.push(`${formatNumber(lang, entry.grams)} ${lang('PlannerUnitGram')}`);
    return parts.join(' · ');
  }
};

function toInput(value?: number) {
  return isKnownNumber(value) ? String(value) : '';
}

export default memo(PlannerNutrition);
