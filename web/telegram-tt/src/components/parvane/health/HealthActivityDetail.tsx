import { memo, useState } from '../../../lib/teact/teact';

import type { HealthGoalTarget } from './HealthGoalSheet';
import type { HealthActivityView, HealthWorkoutView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { barShares, formatPace, workoutTitleKey } from './healthDayFormat';
import {
  formatClock, formatDurationShort, formatNumber, localDayKey, WEEKDAY_KEYS,
} from './healthFormat';
import useHealthPlannedWorkouts from './useHealthPlannedWorkouts';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import HealthQuickInput from './HealthQuickInput';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  activity: HealthActivityView;
  // Компьютер: четыре плитки, «Шаги по дням» и тренировки рядом (доска `XdHealth`); телефон — две плитки
  isWide?: boolean;
  onGoal: (target: HealthGoalTarget) => void;
};

// Parvane (spec 041 B3; доски `XdHealth`, `XpHealth`): активность — шаги сегодня и по дням, активные минуты,
// тренировки и пробег за семь дней. Все числа — из движка (`healthView.activity`)
const HealthActivityDetail = ({ activity, isWide, onGoal }: OwnProps) => {
  const lang = useLang();
  const [today] = useState(() => localDayKey(new Date()));
  const {
    stepsToday, stepsGoal, stepsWeek, activeMinutes, activeGoal, workoutCount, km, workouts,
  } = activity;
  const number = (value: number) => formatNumber(value, lang.code);
  const shares = barShares(stepsWeek.map((item) => item.value), stepsGoal);
  const top = Math.max(stepsGoal || 0, ...stepsWeek.map((item) => item.value || 0)) || 1;
  const planned = useHealthPlannedWorkouts();

  const handleActiveGoal = useLastCallback(() => {
    onGoal({
      kind: 'active_min', title: lang('HealthActiveGoalLabel'), unit: lang('HealthUnitMin'), value: activeGoal,
    });
  });

  function renderTile(id: string, title: string, value: string, hint: string, onClick?: NoneToVoidFunction) {
    return (
      <div className={buildClassName(kit.card, styles.metric, styles.tile)} data-health-tile={id}>
        <span className={kit.muted}>{title}</span>
        <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>{value}</span>
        {onClick ? (
          <button
            type="button"
            className={buildClassName(kit.muted, kit.small, styles.cardLink)}
            data-health-goal-edit={id}
            onClick={onClick}
          >
            {hint}
          </button>
        ) : <span className={buildClassName(kit.muted, kit.small)}>{hint}</span>}
      </div>
    );
  }

  function renderDetails(workout: HealthWorkoutView) {
    const pieces = [lang(WEEKDAY_KEYS[workout.weekday])];
    if (workout.parts.exercises !== undefined) {
      pieces.push(lang('HealthWorkoutExercises', { count: number(workout.parts.exercises) }));
    }
    if (workout.parts.km !== undefined) pieces.push(lang('HealthKmValue', { value: number(workout.parts.km) }));
    if (workout.paceSec !== undefined) pieces.push(lang('HealthWorkoutPace', { pace: formatPace(workout.paceSec) }));
    return pieces.join(' · ');
  }

  return (
    <>
      <div className={styles.metrics} data-health-card="workout">
        {renderTile(
          'steps',
          lang('HealthStepsToday'),
          stepsToday !== undefined ? number(stepsToday) : '—',
          stepsGoal !== undefined ? lang('HealthGoalValue', { value: number(stepsGoal) }) : lang('HealthGoalNone'),
        )}
        {renderTile(
          'active',
          lang('HealthActiveMinutes'),
          number(activeMinutes),
          activeGoal !== undefined
            ? lang('HealthActiveGoalWeek', { goal: number(activeGoal) }) : lang('HealthActiveGoalSet'),
          handleActiveGoal,
        )}
        {isWide && renderTile('count', lang('HealthWorkoutCount'), number(workoutCount), lang('HealthPerWeek'))}
        {isWide && renderTile(
          'km', lang('HealthDistance'), lang('HealthKmValue', { value: number(km) }), lang('HealthPerWeek'),
        )}
      </div>
      <div className={isWide ? styles.detailPair : styles.detail}>
        <section className={buildClassName(kit.card, styles.card)}>
          <div className={kit.caps}>{lang('HealthStepsByDay')}</div>
          <div className={styles.chartBars} style="--health-color: var(--pv-blue)">
            <div className={styles.bars} role="img" aria-label={lang('HealthStepsByDay')}>
              {stepsGoal !== undefined && (
                <span className={styles.goalLine} style={`bottom: ${(stepsGoal / top) * 100}%`} />
              )}
              {stepsWeek.map((item, index) => (
                <span key={item.day} className={styles.barColumn} data-day={item.day}>
                  <span className={styles.barTrack}>
                    <span
                      className={buildClassName(styles.bar, styles.barFull, item.day === today && styles.barToday)}
                      style={`height: ${shares[index] * 100}%`}
                    />
                  </span>
                  <span className={buildClassName(kit.mono, styles.barLabel)}>{lang(WEEKDAY_KEYS[item.weekday])}</span>
                </span>
              ))}
            </div>
          </div>
        </section>
        <section className={buildClassName(kit.card, styles.card)}>
          <div className={kit.caps}>{lang('HealthWorkoutsWeek')}</div>
          {workouts.map((workout) => (
            <div key={workout.id} className={styles.mealRow} data-health-workout={workout.tag}>
              <span className={styles.mealTitle}>{workout.name || lang(workoutTitleKey(workout.tag))}</span>
              <span className={buildClassName(kit.muted, kit.grow, styles.mealNames)}>{renderDetails(workout)}</span>
              <span className={buildClassName(kit.mono, styles.mealKcal)} data-health-value>
                {workout.minutes > 0 ? formatDurationShort(workout.minutes) : '—'}
              </span>
            </div>
          ))}
          {planned.map((workout) => (
            <div key={workout.key} className={styles.mealRow} data-health-workout-planned={workout.tag}>
              <span className={styles.mealTitle}>{workout.name}</span>
              <span className={buildClassName(kit.muted, kit.grow, styles.mealNames)}>
                {[
                  lang(WEEKDAY_KEYS[(workout.weekday + 6) % 7]),
                  workout.start !== undefined
                    ? lang('HealthWorkoutPlannedAt', { time: formatClock(workout.start) })
                    : lang('HealthWorkoutPlanned'),
                ].join(' · ')}
              </span>
              <span className={buildClassName(kit.mono, styles.mealKcal)}>—</span>
            </div>
          ))}
          {!workouts.length && !planned.length && <div className={kit.muted}>{lang('HealthWorkoutsEmpty')}</div>}
        </section>
      </div>
      <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthQuickLine')}</div>
      <HealthQuickInput isCompact placeholder={lang('HealthWorkoutExample')} />
    </>
  );
};

export default memo(HealthActivityDetail);
