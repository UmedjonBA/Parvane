import { memo } from '../../../lib/teact/teact';

import type { HealthActivityView, HealthWorkoutView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { barShares, formatPace, workoutTitleKey } from './healthDayFormat';
import { formatDurationShort, formatNumber, WEEKDAY_KEYS } from './healthFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import HealthGoalInput from './HealthGoalInput';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  activity: HealthActivityView;
  // Заготовка строки ввода тренировки
  onExample: (text: string) => void;
};

// Parvane (spec 041 B3; доски `XdHealth`, `XpHealth`): активность — шаги сегодня и по дням, активные минуты,
// тренировки и пробег за семь дней. Все числа — из движка (`healthView.activity`)
const HealthActivityDetail = ({ activity, onExample }: OwnProps) => {
  const lang = useLang();
  const {
    stepsToday, stepsGoal, stepsWeek, activeMinutes, activeGoal, workoutCount, km, workouts,
  } = activity;
  const number = (value: number) => formatNumber(value, lang.code);
  const shares = barShares(stepsWeek.map((item) => item.value), stepsGoal);

  const handleLine = useLastCallback(() => onExample(lang('HealthWorkoutExample')));

  function renderTile(id: string, title: string, value: string, hint: string) {
    return (
      <div className={buildClassName(kit.card, styles.metric, styles.tile)} data-health-tile={id}>
        <span className={kit.muted}>{title}</span>
        <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>{value}</span>
        <span className={buildClassName(kit.muted, kit.small)}>{hint}</span>
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
          activeGoal !== undefined ? lang('HealthActiveGoalWeek', { goal: number(activeGoal) }) : lang('HealthPerWeek'),
        )}
        {renderTile('count', lang('HealthWorkoutCount'), number(workoutCount), lang('HealthPerWeek'))}
        {renderTile('km', lang('HealthDistance'), lang('HealthKmValue', { value: number(km) }), lang('HealthPerWeek'))}
      </div>
      <section className={buildClassName(kit.card, styles.card)}>
        <div className={kit.caps}>{lang('HealthStepsByDay')}</div>
        <div className={styles.bars} role="img" aria-label={lang('HealthStepsByDay')}>
          {stepsWeek.map((item, index) => (
            <span key={item.day} className={styles.barColumn} data-day={item.day}>
              <span className={styles.barTrack}>
                <span
                  className={buildClassName(styles.bar, styles.barFull)}
                  style={`height: ${shares[index] * 100}%`}
                />
              </span>
              <span className={buildClassName(kit.mono, styles.barLabel)}>{lang(WEEKDAY_KEYS[item.weekday])}</span>
            </span>
          ))}
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
        {!workouts.length && <div className={kit.muted}>{lang('HealthWorkoutsEmpty')}</div>}
        <button
          type="button"
          className={buildClassName(kit.btn, styles.more)}
          data-health-action="workout-line"
          onClick={handleLine}
        >
          {lang('HealthQuickLine')}
        </button>
      </section>
      <section className={buildClassName(kit.card, styles.card)}>
        <HealthGoalInput
          id="active_min"
          label={lang('HealthActiveGoalLabel')}
          value={activeGoal}
          unit={lang('HealthUnitMin')}
        />
      </section>
    </>
  );
};

export default memo(HealthActivityDetail);
