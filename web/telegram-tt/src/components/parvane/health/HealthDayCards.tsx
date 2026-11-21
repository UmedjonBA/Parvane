import { memo } from '../../../lib/teact/teact';

import type { HealthActivityView, HealthNutritionView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { FOOD_KIND, goalShare, WORKOUT_KIND } from './healthDayFormat';
import { formatNumber } from './healthFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type NutritionProps = {
  nutrition: HealthNutritionView;
  onOpen: (kind: string) => void;
};

// Parvane (spec 041 B3, доска `XdHealth`): плитка «Питание» на сводке — калории за день и остаток до цели
export const HealthNutritionCard = memo(({ nutrition, onOpen }: NutritionProps) => {
  const lang = useLang();
  const { total, goals, left, closed: isClosed } = nutrition;
  const goal = goals.kcal;
  const number = (value: number) => formatNumber(value, lang.code);

  const handleOpen = useLastCallback(() => onOpen(FOOD_KIND));

  function renderHint() {
    if (isClosed) return lang('HealthDayClosed');
    if (goal === undefined || left === undefined) return lang('HealthNutritionNoGoal');
    return left >= 0
      ? lang('HealthKcalLeft', { left: number(left), goal: number(goal) })
      : lang('HealthKcalOver', { over: number(-left), goal: number(goal) });
  }

  return (
    <section className={buildClassName(kit.card, styles.card)} data-health-card={FOOD_KIND}>
      <button type="button" className={styles.waterHead} onClick={handleOpen}>
        <span className={buildClassName(kit.caps, kit.grow)}>{lang('ParvaneHealthBlockFood')}</span>
        <span>
          <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>{number(total.kcal)}</span>
          <span className={kit.muted}>{` ${lang('HealthUnitKcal')}`}</span>
        </span>
      </button>
      {goal !== undefined && (
        <span className={styles.waterTrack} aria-hidden>
          <span className={styles.dayFill} style={`width: ${goalShare(total.kcal, goal) * 100}%`} />
        </span>
      )}
      <div className={buildClassName(kit.muted, kit.small)} data-health-hint>{renderHint()}</div>
    </section>
  );
});

type ActivityProps = {
  activity: HealthActivityView;
  onOpen: (kind: string) => void;
};

// Плитка «Активность»: активные минуты за семь дней и цель недели
export const HealthActivityCard = memo(({ activity, onOpen }: ActivityProps) => {
  const lang = useLang();
  const { activeMinutes, activeGoal, workoutCount } = activity;

  const handleOpen = useLastCallback(() => onOpen(WORKOUT_KIND));

  return (
    <section className={buildClassName(kit.card, styles.card)} data-health-card={WORKOUT_KIND}>
      <button type="button" className={styles.waterHead} onClick={handleOpen}>
        <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthActivityTitle')}</span>
        <span>
          <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>
            {formatNumber(activeMinutes, lang.code)}
          </span>
          <span className={kit.muted}>{` ${lang('HealthUnitMin')}`}</span>
        </span>
      </button>
      {activeGoal !== undefined && (
        <span className={styles.waterTrack} aria-hidden>
          <span className={styles.dayFill} style={`width: ${goalShare(activeMinutes, activeGoal) * 100}%`} />
        </span>
      )}
      <div className={buildClassName(kit.muted, kit.small)}>
        {activeGoal !== undefined
          ? lang('HealthActiveGoalWeek', { goal: formatNumber(activeGoal, lang.code) })
          : lang('HealthWorkoutCountWeek', { count: workoutCount })}
      </div>
    </section>
  );
});
