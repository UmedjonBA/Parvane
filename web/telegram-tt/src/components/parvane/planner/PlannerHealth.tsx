import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type {
  PlannerFoodEntry, PlannerHealthKind, PlannerHealthRecord, PlannerMetric, PlannerNutrient, PlannerState,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDuration, formatHours, formatSpan, formatWeekday,
} from './plannerFormat';
import {
  applyQuickDraft, formatPace, getActiveMinutes, getDailyRecord, getDailySeries, getLastDays, getLatestRecord,
  getLimitTotal, getWorkouts, SHORT_SLEEP_MINUTES,
} from './plannerHealth';
import {
  addDays, fromDayKey, getGoalsForDay, getNutrientTotal, toTime,
} from './plannerModel';
import { getQuickLang, parseQuickInput } from './plannerQuick';
import { showPlannerNotice, updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  // Пример строки открывает ввод текстом с готовым текстом
  onExample: (text: string) => void;
};

const MACROS: { nutrient: Exclude<PlannerNutrient, 'kcal'>; label: 'PlannerHealthProtein' | 'PlannerHealthFat'
  | 'PlannerHealthCarbs' | 'PlannerHealthFiber'; }[] = [
  { nutrient: 'protein', label: 'PlannerHealthProtein' },
  { nutrient: 'fat', label: 'PlannerHealthFat' },
  { nutrient: 'carbs', label: 'PlannerHealthCarbs' },
  { nutrient: 'fiber', label: 'PlannerHealthFiber' },
];
const LIMITS = [
  { nutrient: 'sugar', label: 'PlannerHealthSugar', goal: 'sugarMax' },
  { nutrient: 'salt', label: 'PlannerHealthSalt', goal: 'saltMax' },
] as const;
const MEAL_LABELS = {
  breakfast: 'PlannerMealBreakfast',
  lunch: 'PlannerMealLunch',
  dinner: 'PlannerMealDinner',
  snack: 'PlannerMealSnack',
  other: 'PlannerMealOther',
} as const;
const PERCENT = 100;
const GLASS_ML = 250;
const BOTTLE_ML = 500;
const ML_IN_LITRE = 1000;
const WEIGHT_DAYS = 21;
const WEEK = 7;
const MINUTES_IN_HOUR = 60;
const THOUSAND = 1000;

function share(value: number, goal?: number) {
  return goal ? Math.min(1, value / goal) * PERCENT : 0;
}

// «Здоровье» (spec 020): питание, вода, тело, сон, активность и цели — сводкой дня; всё вводится текстом
const PlannerHealth = ({
  state, day, today, onExample,
}: OwnProps) => {
  const [goalText, setGoalText] = useState('');

  const lang = useLang();

  // Примеры строк — на языке интерфейса: их разбирает словарь того же языка
  const examples = useMemo(() => lang('PlannerHealthExamples').split(/\s*\|\s*/).filter(Boolean), [lang]);
  const week = useMemo(() => getLastDays(day), [day]);
  const goals = getGoalsForDay(state, day, today);
  const { healthGoals } = state;
  const nutritionDay = state.nutrition[day];
  const entries = useMemo(() => [...(nutritionDay?.entries || [])]
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99')), [nutritionDay]);
  const number = (value: number, digits = 0) => lang.number(Math.round(value * 10 ** digits) / 10 ** digits);
  const total = (nutrient: PlannerMetric | 'fiber') => getNutrientTotal(state, day, nutrient).value;
  const goalLabel = (value: string) => lang('PlannerHealthGoalValue', { value });
  const litres = (ml: number) => lang('PlannerHealthLitres', { value: number(ml / ML_IN_LITRE, 1) });
  const formatSteps = (value: number) => (value >= THOUSAND ? `${number(value / THOUSAND, 1)}k` : String(value));

  const kcal = total('kcal');
  const kcalGoal = goals.kcal?.target;
  const waterMl = nutritionDay?.waterMl || 0;
  const waterGoal = goals.water?.target;

  const weight = getLatestRecord(state, 'weight', day);
  const weightBefore = weight && getLatestRecord(state, 'weight', addDays(weight.day, -WEEK));
  const weightChange = weight && weightBefore && weightBefore.id !== weight.id
    ? weight.value - weightBefore.value : undefined;
  const weightDays = useMemo(() => getLastDays(day, WEIGHT_DAYS), [day]);
  const weightSeries = useMemo(() => getDailySeries(state, 'weight', weightDays), [state, weightDays]);
  const pressure = getLatestRecord(state, 'pressure', day);
  const pulse = getLatestRecord(state, 'pulse', day);
  const mood = getDailyRecord(state, 'mood', day);

  const sleep = getDailyRecord(state, 'sleep', day);
  const sleepSeries = useMemo(() => getDailySeries(state, 'sleep', week), [state, week]);
  const knownSleep = sleepSeries.filter((value): value is number => value !== undefined);
  const sleepAverage = knownSleep.length ? knownSleep.reduce((a, b) => a + b, 0) / knownSleep.length : undefined;

  const steps = getDailyRecord(state, 'steps', day)?.value || 0;
  const stepSeries = useMemo(() => getDailySeries(state, 'steps', week), [state, week]);
  const workouts = useMemo(() => getWorkouts(state, week), [state, week]);
  const activeMinutes = useMemo(() => getActiveMinutes(state, week), [state, week]);

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(e.currentTarget.dataset.text!);
  });

  const handleWater = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const amount = Number(e.currentTarget.dataset.ml);
    updatePlanner((draft) => {
      const record = draft.nutrition[day] || { entries: [], isComplete: false };
      draft.nutrition[day] = { ...record, waterMl: (record.waterMl || 0) + amount };
    }, lang('PlannerNoticeAdded', { name: lang('PlannerHealthMl', { value: amount }) }));
  });

  const handleDeleteEntry = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { id } = e.currentTarget.dataset;
    updatePlanner((draft) => {
      const record = draft.nutrition[day];
      if (record) draft.nutrition[day] = { ...record, entries: record.entries.filter((entry) => entry.id !== id) };
    }, lang('PlannerNoticeHealthDeleted'));
  });

  const handleDeleteRecord = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { id } = e.currentTarget.dataset;
    updatePlanner((draft) => {
      draft.health = draft.health.filter((record) => record.id !== id);
    }, lang('PlannerNoticeHealthDeleted'));
  });

  const handleGoalText = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setGoalText(e.currentTarget.value);
  });

  // Та же грамматика, что у строки «цель …» в окне ввода
  const handleGoalSubmit = useLastCallback((e: React.FormEvent) => {
    e.preventDefault();
    const draft = parseQuickInput(goalText, {
      today,
      nowMinutes: 0,
      dayStart: state.settings.dayStart,
      dayEnd: state.settings.dayEnd,
      kind: 'goal',
      lang: getQuickLang(lang.code),
    });
    if (draft.error) {
      showPlannerNotice(lang('PlannerHealthGoalsBad'));
      return;
    }
    updatePlanner((next) => {
      applyQuickDraft(next, draft, today);
    }, lang('PlannerNoticeGoalsSaved'));
    setGoalText('');
  });

  const renderBars = (values: (number | undefined)[], format: (value: number) => string, kind: PlannerHealthKind) => {
    const max = Math.max(1, ...values.map((value) => value || 0));
    return (
      <div className={styles.healthBars} data-health-bars={kind}>
        {values.map((value, index) => (
          <div key={week[index]} className={styles.healthBarColumn}>
            <span className={styles.healthBarValue}>{value === undefined ? '' : format(value)}</span>
            <span className={styles.healthBarTrack}>
              <span className={styles.healthBarFill} style={`height: ${((value || 0) / max) * PERCENT}%`} />
            </span>
            <span className={styles.small}>
              {formatWeekday(lang, (fromDayKey(week[index]).getDay() + 6) % WEEK)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  const renderRow = (label: string, value: string, fraction: number, isOver?: boolean) => (
    <div className={styles.healthRow}>
      <div className={styles.healthRowHead}>
        <span>{label}</span>
        <span className={buildClassName(styles.healthRowValue, isOver && styles.warning)}>{value}</span>
      </div>
      <span className={styles.todayBar}>
        <span className={isOver ? styles.todayBarOver : styles.todayBarFill} style={`width: ${fraction}%`} />
      </span>
    </div>
  );

  const renderMeal = (entry: PlannerFoodEntry) => {
    const macros = entry.protein !== undefined || entry.fat !== undefined || entry.carbs !== undefined
      ? lang('PlannerHealthMacros', {
        protein: number(entry.protein || 0), fat: number(entry.fat || 0), carbs: number(entry.carbs || 0),
      }) : undefined;
    const fiber = entry.fiber !== undefined
      ? lang('PlannerHealthFiberShort', { value: number(entry.fiber) }) : undefined;
    return (
      <div key={entry.id} className={styles.healthItem} data-health-meal={entry.id}>
        <span className={styles.agendaTime}>{entry.time || ''}</span>
        <span className={styles.healthItemBody}>
          <span>{`${lang(MEAL_LABELS[entry.meal])}: ${entry.name}`}</span>
          <span className={styles.small}>{[macros, fiber].filter(Boolean).join(' · ')}</span>
        </span>
        <span className={styles.healthRowValue}>{number(entry.kcal)}</span>
        <button
          type="button"
          className={styles.quickChipRemove}
          data-id={entry.id}
          aria-label={lang('PlannerHealthDelete', { name: entry.name })}
          onClick={handleDeleteEntry}
        >
          <Icon name="close" />
        </button>
      </div>
    );
  };

  const renderWorkout = (record: PlannerHealthRecord) => {
    const pace = formatPace(record.value, record.value2 || 0);
    const details = [
      record.value ? formatDuration(lang, record.value) : undefined,
      record.value2 ? lang('PlannerHealthKm', { value: number(record.value2, 1) }) : undefined,
      pace ? lang('PlannerHealthPace', { value: pace }) : undefined,
      record.exercises?.map((exercise) => (
        `${exercise.name} ${[exercise.sets, exercise.reps, exercise.weight].filter(Boolean).join('×')}`
      )).join(', '),
    ].filter(Boolean).join(' · ');
    return (
      <div key={record.id} className={styles.healthItem} data-health-workout={record.id}>
        <span className={styles.healthItemBody}>
          <span>{record.name}</span>
          <span className={styles.small}>{details}</span>
        </span>
        <span className={styles.small}>{formatDay(lang, record.day)}</span>
        <button
          type="button"
          className={styles.quickChipRemove}
          data-id={record.id}
          aria-label={lang('PlannerHealthDelete', { name: record.name || '' })}
          onClick={handleDeleteRecord}
        >
          <Icon name="close" />
        </button>
      </div>
    );
  };

  const weightKnown = weightSeries.filter((value): value is number => value !== undefined);
  const weightMin = Math.min(...weightKnown, healthGoals.weight ?? Infinity);
  const weightMax = Math.max(...weightKnown, healthGoals.weight ?? -Infinity);
  const weightRange = Math.max(0.5, weightMax - weightMin);

  return (
    <div className={styles.health} data-planner-health={day}>
      <section className={styles.healthCard} data-health="hint">
        <h3 className={styles.healthTitle}>{lang('PlannerHealthHintTitle')}</h3>
        <p className={styles.small}>{lang('PlannerHealthHint')}</p>
        <div className={styles.quickChips}>
          {examples.map((text) => (
            <button key={text} type="button" className={styles.healthExample} data-text={text} onClick={handleExample}>
              {text}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.healthCard} data-health="nutrition">
        <div className={styles.healthHead}>
          <h3 className={styles.healthTitle}>{lang('PlannerHealthNutrition')}</h3>
          {Boolean(kcalGoal) && <span className={styles.small}>{goalLabel(number(kcalGoal))}</span>}
        </div>
        <div className={styles.healthBig}>
          <span className={styles.todayCardValue}>{number(kcal)}</span>
          <span className={styles.small}>
            {lang('PlannerHealthKcal', { value: '' }).trim()}
            {kcalGoal ? ` · ${kcal > kcalGoal
              ? lang('PlannerHealthKcalOver', { value: number(kcal - kcalGoal) })
              : lang('PlannerHealthKcalLeft', { value: number(kcalGoal - kcal) })}` : ''}
          </span>
        </div>
        {MACROS.map(({ nutrient, label }) => {
          const value = total(nutrient);
          const goal = goals[nutrient]?.target;
          return renderRow(
            lang(label),
            goal ? lang('PlannerHealthGrams', { value: number(value), goal: number(goal) })
              : lang('PlannerHealthGramsNoGoal', { value: number(value) }),
            share(value, goal),
          );
        })}
        {LIMITS.map(({ nutrient, label, goal }) => {
          const value = getLimitTotal(state, day, nutrient);
          const limit = healthGoals[goal];
          return renderRow(
            lang(label),
            limit ? lang('PlannerHealthLimit', { value: number(value, 1), goal: number(limit, 1) })
              : lang('PlannerHealthGramsNoGoal', { value: number(value, 1) }),
            share(value, limit),
            Boolean(limit) && value > limit,
          );
        })}
        {!entries.length && <p className={styles.small}>{lang('PlannerHealthNoMeals')}</p>}
        {entries.map(renderMeal)}
      </section>

      <section className={styles.healthCard} data-health="water">
        <div className={styles.healthHead}>
          <h3 className={styles.healthTitle}>{lang('PlannerHealthWater')}</h3>
          {Boolean(waterGoal) && <span className={styles.small}>{goalLabel(litres(waterGoal))}</span>}
        </div>
        <div className={styles.healthBig}>
          <span className={styles.todayCardValue}>{number(waterMl / ML_IN_LITRE, 2)}</span>
          <span className={styles.small}>{lang('PlannerHealthLitres', { value: '' }).trim()}</span>
        </div>
        <span className={styles.todayBar}>
          <span className={styles.todayBarFill} style={`width: ${share(waterMl, waterGoal)}%`} />
        </span>
        <div className={styles.quickChips}>
          <button type="button" className={styles.healthExample} data-ml={GLASS_ML} onClick={handleWater}>
            {lang('PlannerHealthAddGlass')}
          </button>
          <button type="button" className={styles.healthExample} data-ml={BOTTLE_ML} onClick={handleWater}>
            {lang('PlannerHealthAddBottle')}
          </button>
        </div>
      </section>

      <section className={styles.healthCard} data-health="body">
        <div className={styles.healthHead}>
          <h3 className={styles.healthTitle}>{lang('PlannerHealthBody')}</h3>
          {Boolean(healthGoals.weight) && (
            <span className={styles.small}>
              {goalLabel(lang('PlannerHealthKg', { value: number(healthGoals.weight, 1) }))}
            </span>
          )}
        </div>
        <div className={styles.healthBig}>
          <span className={styles.todayCardValue}>{weight ? number(weight.value, 1) : '—'}</span>
          <span className={styles.small}>
            {lang('PlannerHealthKg', { value: '' }).trim()}
            {weightChange !== undefined ? ` · ${lang('PlannerHealthWeekChange', {
              value: `${weightChange > 0 ? '+' : ''}${number(weightChange, 1)}`,
            })}` : ''}
          </span>
        </div>
        {weightKnown.length > 1 && (
          <div className={styles.healthDots} data-health-weight>
            {weightSeries.map((value, index) => (
              <span key={weightDays[index]} className={styles.healthDotColumn}>
                {value !== undefined && (
                  <span
                    className={styles.healthDot}
                    style={`bottom: ${((value - weightMin) / weightRange) * PERCENT}%`}
                  />
                )}
              </span>
            ))}
          </div>
        )}
        <div className={styles.healthFacts}>
          <span className={styles.healthFact}>
            <span className={styles.small}>{lang('PlannerHealthPressure')}</span>
            <span className={styles.healthRowValue}>
              {pressure ? `${pressure.value}/${pressure.value2 || 0}` : '—'}
            </span>
          </span>
          <span className={styles.healthFact}>
            <span className={styles.small}>{lang('PlannerHealthPulse')}</span>
            <span className={styles.healthRowValue}>
              {pulse ? lang('PlannerHealthBpm', { value: number(pulse.value) }) : '—'}
            </span>
          </span>
          <span className={styles.healthFact}>
            <span className={styles.small}>{lang('PlannerHealthMood')}</span>
            <span className={styles.healthRowValue}>{mood ? number(mood.value) : '—'}</span>
          </span>
        </div>
      </section>

      <section className={styles.healthCard} data-health="sleep">
        <div className={styles.healthHead}>
          <h3 className={styles.healthTitle}>{lang('PlannerHealthSleep')}</h3>
          {sleepAverage !== undefined && (
            <span className={styles.small}>
              {lang('PlannerHealthSleepAverage', { value: formatSpan(sleepAverage) })}
            </span>
          )}
        </div>
        <div className={styles.healthBig}>
          <span className={styles.todayCardValue}>{sleep ? formatSpan(sleep.value) : '—'}</span>
          <span className={styles.small}>
            {sleep?.time && sleep.endTime ? `${sleep.time} → ${sleep.endTime}`
              : !sleep ? lang('PlannerHealthSleepNone') : ''}
          </span>
        </div>
        {renderBars(sleepSeries, formatSpan, 'sleep')}
        <p className={styles.small}>
          {lang('PlannerHealthSleepShort', { hours: SHORT_SLEEP_MINUTES / MINUTES_IN_HOUR })}
        </p>
      </section>

      <section className={styles.healthCard} data-health="activity">
        <h3 className={styles.healthTitle}>{lang('PlannerHealthActivity')}</h3>
        {renderRow(
          lang('PlannerHealthSteps'),
          healthGoals.steps ? `${number(steps)} / ${number(healthGoals.steps)}` : number(steps),
          share(steps, healthGoals.steps),
        )}
        {renderRow(
          lang('PlannerHealthActiveMinutes'),
          healthGoals.activeMinutes
            ? lang('PlannerHealthMinutes', { value: `${number(activeMinutes)} / ${number(healthGoals.activeMinutes)}` })
            : lang('PlannerHealthMinutes', { value: number(activeMinutes) }),
          share(activeMinutes, healthGoals.activeMinutes),
        )}
        {renderRow(
          lang('PlannerHealthWorkouts'),
          healthGoals.workouts ? `${workouts.length} / ${healthGoals.workouts}` : String(workouts.length),
          share(workouts.length, healthGoals.workouts),
        )}
        {renderBars(stepSeries, formatSteps, 'steps')}
        {!workouts.length && <p className={styles.small}>{lang('PlannerHealthNoWorkouts')}</p>}
        {workouts.map(renderWorkout)}
      </section>

      <section className={styles.healthCard} data-health="goals">
        <h3 className={styles.healthTitle}>{lang('PlannerHealthGoals')}</h3>
        <p className={styles.small} data-health-goals-summary>
          {[
            kcalGoal ? lang('PlannerHealthKcal', { value: number(kcalGoal) }) : undefined,
            ...MACROS.map(({ nutrient, label }) => (
              goals[nutrient] ? `${lang(label)} ${number(goals[nutrient].target)}` : undefined
            )),
            waterGoal ? `${lang('PlannerHealthWater')} ${litres(waterGoal)}` : undefined,
            healthGoals.sleepMinutes
              ? `${lang('PlannerHealthSleep')} ${formatSpan(healthGoals.sleepMinutes)}` : undefined,
            healthGoals.steps ? `${lang('PlannerHealthStepsShort')} ${number(healthGoals.steps)}` : undefined,
            lang('PlannerHealthDayWindow', {
              from: toTime(state.settings.dayStart),
              to: toTime(state.settings.dayEnd),
              budget: formatHours(lang, state.budget),
            }),
          ].filter(Boolean).join(' · ')}
        </p>
        <form className={styles.healthGoalForm} onSubmit={handleGoalSubmit}>
          <input
            id="planner-health-goals"
            className={buildClassName('form-control', styles.quickInput)}
            type="text"
            value={goalText}
            placeholder={lang('PlannerHealthGoalsPlaceholder')}
            aria-label={lang('PlannerHealthGoalsText')}
            autoComplete="off"
            onChange={handleGoalText}
          />
          <button type="submit" className={styles.healthExample} disabled={!goalText.trim()}>
            {lang('PlannerHealthGoalsApply')}
          </button>
        </form>
      </section>
    </div>
  );
};

export default memo(PlannerHealth);
