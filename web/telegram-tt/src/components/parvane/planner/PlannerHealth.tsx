import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { SleepNight } from './plannerHealth';
import type {
  PlannerFoodEntry, PlannerHealthRecord, PlannerMetric, PlannerNutrient, PlannerState,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayShort, formatDuration, formatHours, formatSpan, formatWeekday,
} from './plannerFormat';
import {
  applyQuickDraft, clockDifference, formatPace, getClockGoal, getDailyRecord, getDailySeries, getLastDays,
  getLatestRecord, getLimitTotal, getSleepRoutine, getWorkouts, SHORT_SLEEP_MINUTES, SLEEP_ROUTINE_DRIFTING_SPREAD,
  SLEEP_ROUTINE_MIN_NIGHTS, SLEEP_ROUTINE_STABLE_SPREAD, sumActiveMinutes, wrapClock,
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
  onOpenSettings: NoneToVoidFunction;
};

// Цвет строки нутриента — как у прототипа: белки, жиры, углеводы, клетчатка, сахар, соль
const MACROS: { nutrient: Exclude<PlannerNutrient, 'kcal'>; label: 'PlannerHealthProtein' | 'PlannerHealthFat'
  | 'PlannerHealthCarbs' | 'PlannerHealthFiber'; kind: string; }[] = [
  { nutrient: 'protein', label: 'PlannerHealthProtein', kind: styles.kindSleep },
  { nutrient: 'fat', label: 'PlannerHealthFat', kind: styles.kindNote },
  { nutrient: 'carbs', label: 'PlannerHealthCarbs', kind: styles.kindFood },
  { nutrient: 'fiber', label: 'PlannerHealthFiber', kind: styles.kindWorkout },
];
const LIMITS = [
  {
    nutrient: 'sugar', label: 'PlannerHealthSugar', goal: 'sugarMax', kind: styles.kindMetric,
  },
  {
    nutrient: 'salt', label: 'PlannerHealthSalt', goal: 'saltMax', kind: styles.kindTask,
  },
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
// Столбики занимают эту долю высоты графика (остальное — подписи значений), над самым высоким — запас
const BAR_AREA = 86;
const BAR_HEADROOM = 1.15;
const SPARK_WIDTH = 300;
const SPARK_HEIGHT = 90;
const SPARK_PAD = 6;
const SPARK_DOT = 4;
const WEIGHT_PAD_KG = 0.5;
// Режим сна: уровень — плашкой своего тона
const ROUTINE_LEVELS = {
  stable: { label: 'PlannerSleepRoutineStable', tone: styles.toneGood },
  drifting: { label: 'PlannerSleepRoutineDrifting', tone: styles.toneWarn },
  broken: { label: 'PlannerSleepRoutineBroken', tone: styles.kindDue },
  none: { label: 'PlannerSleepRoutineNone', tone: styles.kindMuted },
} as const;
// График режима: ночи столбиками, справа — поле подписей времени (та же доля — у подписей дней в стилях)
const ROUTINE_WIDTH = 300;
const ROUTINE_HEIGHT = 120;
const ROUTINE_GUTTER = 36;
const ROUTINE_PAD = 8;
const ROUTINE_BAR_SHARE = 0.56;
const ROUTINE_BAR_RADIUS = 2;
const ROUTINE_DOT = 3;
const ROUTINE_LABEL_SHIFT = 4;
// Запас оси над самым ранним отходом ко сну и под самым поздним подъёмом, мин
const ROUTINE_AXIS_PAD = 30;
// Половина оси, когда ночей со временем нет
const ROUTINE_EMPTY_SPAN = 360;
// Среднее время показывается с точностью до пяти минут
const CLOCK_STEP = 5;
// Среднее ближе этого к цели — «по цели»
const ON_GOAL_MINUTES = 10;

function roundToStep(minutes: number) {
  return Math.round(minutes / CLOCK_STEP) * CLOCK_STEP;
}

function share(value: number, goal?: number) {
  return goal ? Math.min(1, value / goal) * PERCENT : 0;
}

type TextFormProps = {
  id: string;
  placeholder: string;
  label: string;
  buttonText: string;
  buttonClassName: string;
  // `true` — строка принята, поле очищается
  onSubmit: (text: string) => boolean;
};

// Строка ввода с кнопкой («сон дня», «цели»): набираемый текст — состояние поля, а не экрана, иначе каждый
// символ перерисовывал бы весь экран «Здоровья»
const HealthTextForm = memo(({
  id, placeholder, label, buttonText, buttonClassName, onSubmit,
}: TextFormProps) => {
  const [text, setText] = useState('');

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
  });

  const handleSubmit = useLastCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (onSubmit(text)) setText('');
  });

  return (
    <form className={styles.healthGoalForm} onSubmit={handleSubmit}>
      <input
        id={id}
        className={buildClassName('form-control', styles.fieldInput)}
        type="text"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        onChange={handleChange}
      />
      <button type="submit" className={buttonClassName} disabled={!text.trim()}>{buttonText}</button>
    </form>
  );
});

// «Здоровье» (spec 020): питание, вода и тело, сон, активность, калории недели и цели — сводкой дня; всё
// вводится текстом
const PlannerHealth = ({
  state, day, today, onExample, onOpenSettings,
}: OwnProps) => {
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
  const isClosed = Boolean(nutritionDay?.isComplete);
  const isKcalOver = kcalGoal ? kcal > kcalGoal : false;
  const kcalSeries = useMemo(() => (
    week.map((key) => Math.round(getNutrientTotal(state, key, 'kcal').value) || undefined)
  ), [state, week]);
  const knownKcal = kcalSeries.filter((value): value is number => value !== undefined);
  const kcalAverage = knownKcal.length ? knownKcal.reduce((a, b) => a + b, 0) / knownKcal.length : undefined;

  // Последние записи тела — одним вычислением на состояние и день
  const {
    weight, weightChange, pressure, pulse,
  } = useMemo(() => {
    const latest = getLatestRecord(state, 'weight', day);
    const before = latest && getLatestRecord(state, 'weight', addDays(latest.day, -WEEK));
    return {
      weight: latest,
      weightChange: latest && before && before.id !== latest.id ? latest.value - before.value : undefined,
      pressure: getLatestRecord(state, 'pressure', day),
      pulse: getLatestRecord(state, 'pulse', day),
    };
  }, [state, day]);
  const weightDays = useMemo(() => getLastDays(day, WEIGHT_DAYS), [day]);
  const weightSeries = useMemo(() => getDailySeries(state, 'weight', weightDays), [state, weightDays]);
  const mood = getDailyRecord(state, 'mood', day);

  const sleep = getDailyRecord(state, 'sleep', day);
  const isShortNight = sleep ? sleep.value < SHORT_SLEEP_MINUTES : false;
  const sleepSeries = useMemo(() => getDailySeries(state, 'sleep', week), [state, week]);
  const knownSleep = sleepSeries.filter((value): value is number => value !== undefined);
  const sleepAverage = knownSleep.length ? knownSleep.reduce((a, b) => a + b, 0) / knownSleep.length : undefined;
  const routine = useMemo(() => getSleepRoutine(state, day), [state, day]);
  // Цель режима — минуты от полуночи: полночь (ноль) — тоже цель
  const goalBed = getClockGoal(healthGoals.bedtime);
  const goalWake = getClockGoal(healthGoals.wakeTime);
  const routineGoal = goalBed !== undefined && goalWake !== undefined
    ? { bed: toTime(goalBed), wake: toTime(goalWake) } : undefined;

  const steps = getDailyRecord(state, 'steps', day)?.value || 0;
  const stepSeries = useMemo(() => getDailySeries(state, 'steps', week), [state, week]);
  const workouts = useMemo(() => getWorkouts(state, week), [state, week]);
  const activeMinutes = useMemo(() => sumActiveMinutes(workouts), [workouts]);

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(e.currentTarget.dataset.text!);
  });

  const handleAddSleep = useLastCallback(() => {
    onExample(lang('PlannerHealthSleepExample'));
  });

  const handleRoutineGoal = useLastCallback(() => {
    onExample(lang('PlannerSleepRoutineGoalExample'));
  });

  // Сон дня экрана: ввод через «+» пишет в сегодняшний день, а режим складывается и из прошлых ночей
  const handleSleepSubmit = useLastCallback((sleepText: string) => {
    const draft = parseQuickInput(sleepText, {
      today: day,
      nowMinutes: 0,
      dayStart: state.settings.dayStart,
      dayEnd: state.settings.dayEnd,
      kind: 'sleep',
      lang: getQuickLang(lang.code),
    });
    if (draft.error || draft.kind !== 'sleep') {
      showPlannerNotice(lang('PlannerHealthSleepDayBad'));
      return false;
    }
    updatePlanner((next) => {
      applyQuickDraft(next, draft, day);
    }, lang('PlannerNoticeAdded', { name: lang('PlannerHealthSleep') }));
    return true;
  });

  const handleAddWorkout = useLastCallback(() => {
    onExample(lang('PlannerHealthWorkoutExample'));
  });

  const handleWater = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const amount = Number(e.currentTarget.dataset.ml);
    updatePlanner((draft) => {
      const record = draft.nutrition[day] || { entries: [], isComplete: false };
      draft.nutrition[day] = { ...record, waterMl: (record.waterMl || 0) + amount };
    }, lang('PlannerNoticeAdded', { name: lang('PlannerHealthMl', { value: amount }) }));
  });

  // День питания закрыт — итог дня считается окончательным (`isDayClosed`)
  const handleToggleClosed = useLastCallback(() => {
    updatePlanner((draft) => {
      const record = draft.nutrition[day] || { entries: [], isComplete: false };
      draft.nutrition[day] = { ...record, isComplete: !record.isComplete };
    }, lang(isClosed ? 'PlannerHealthDayReopened' : 'PlannerHealthDayClosed'));
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

  // Та же грамматика, что у строки «цель …» в окне ввода
  const handleGoalSubmit = useLastCallback((goalText: string) => {
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
      return false;
    }
    updatePlanner((next) => {
      applyQuickDraft(next, draft, today);
    }, lang('PlannerNoticeGoalsSaved'));
    return true;
  });

  // Столбики недели: значение над столбиком, пунктир цели, день экрана обведён
  const renderBars = (
    values: (number | undefined)[], format: (value: number) => string, kind: string, kindClass: string,
    goal?: number, isLow?: (value: number) => boolean,
  ) => {
    const max = Math.max(1, goal || 0, ...values.map((value) => value || 0)) * BAR_HEADROOM;
    return (
      <div className={kindClass}>
        <div className={styles.bars} data-health-bars={kind}>
          {goal ? (
            <div className={styles.barsGoal} style={`bottom: ${(goal / max) * BAR_AREA}%`}>
              <span className={styles.barsGoalLabel}>{format(goal)}</span>
            </div>
          ) : undefined}
          {values.map((value, index) => (
            <div
              key={week[index]}
              className={buildClassName(
                styles.barsColumn,
                value !== undefined && isLow?.(value) && styles.barsColumnLow,
                week[index] === day && styles.barsColumnCurrent,
              )}
            >
              <span className={styles.barsValue}>{value ? format(value) : '—'}</span>
              <span className={styles.barsFill} style={`height: ${((value || 0) / max) * BAR_AREA}%`} />
            </div>
          ))}
        </div>
        <div className={styles.barsLabels}>
          {week.map((key) => (
            <span key={key} className={buildClassName(styles.barsLabel, key === day && styles.barsLabelCurrent)}>
              {formatWeekday(lang, (fromDayKey(key).getDay() + 6) % WEEK)}
            </span>
          ))}
        </div>
      </div>
    );
  };

  // Строка нутриента: название, «значение / цель», полоса
  const renderMacro = (label: string, value: string, goalPart: string, fraction: number, kindClass: string) => (
    <div key={label} className={styles.macroRow}>
      <span className={styles.muted}>{label}</span>
      <span className={buildClassName(styles.mono, kindClass === styles.kindDue && styles.red)}>
        {value}
        <span className={styles.muted}>{goalPart}</span>
      </span>
      <span className={buildClassName(styles.prog, kindClass)}>
        <span className={styles.progFill} style={`width: ${fraction}%`} />
      </span>
    </div>
  );

  const renderProgress = (label: string, value: string, goalPart: string, fraction: number, kindClass: string) => (
    <div className={kindClass}>
      <div className={styles.healthRowHead}>
        <span>{label}</span>
        <span className={styles.mono}>
          <b className={styles.healthRowValue}>{value}</b>
          <span className={styles.muted}>{goalPart}</span>
        </span>
      </div>
      <span className={buildClassName(styles.prog, styles.progThick)}>
        <span className={styles.progFill} style={`width: ${fraction}%`} />
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
      <div key={entry.id} className={styles.row} data-health-meal={entry.id}>
        <span className={styles.healthTime}>{entry.time || ''}</span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{`${lang(MEAL_LABELS[entry.meal])}: ${entry.name}`}</span>
          <span className={buildClassName(styles.rowSub, styles.mono)}>
            {[macros, fiber].filter(Boolean).join(' · ') || lang('PlannerHealthNoMacros')}
          </span>
        </span>
        <span className={styles.rowMeta}>{number(entry.kcal)}</span>
        <button
          type="button"
          className={buildClassName(styles.ib, styles.ibSmall)}
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
      <div key={record.id} className={styles.row} data-health-workout={record.id}>
        <span className={buildClassName(styles.rowIcon, styles.kindWorkout)}><Icon name="sport" /></span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{record.name}</span>
          <span className={styles.rowSub}>{details}</span>
        </span>
        <span className={styles.rowMeta}>{formatDayShort(lang, record.day)}</span>
        <button
          type="button"
          className={buildClassName(styles.ib, styles.ibSmall)}
          data-id={record.id}
          aria-label={lang('PlannerHealthDelete', { name: record.name || '' })}
          onClick={handleDeleteRecord}
        >
          <Icon name="close" />
        </button>
      </div>
    );
  };

  // График веса за три недели: ломаная по записям, пунктир цели, точка последней записи
  const renderWeight = () => {
    const known = weightSeries
      .map((value, index) => ({ value, index }))
      .filter((point): point is { value: number; index: number } => point.value !== undefined);
    if (!known.length) return <p className={styles.muted}>{lang('PlannerHealthNoRecords')}</p>;
    const goal = healthGoals.weight;
    const values = known.map((point) => point.value);
    const low = Math.min(...values, goal ?? Infinity) - WEIGHT_PAD_KG;
    const high = Math.max(...values, goal ?? -Infinity) + WEIGHT_PAD_KG;
    const x = (index: number) => SPARK_PAD + (index * (SPARK_WIDTH - SPARK_PAD * 2)) / (WEIGHT_DAYS - 1);
    const y = (value: number) => (
      SPARK_HEIGHT - SPARK_PAD - ((value - low) / (high - low)) * (SPARK_HEIGHT - SPARK_PAD * 2)
    );
    const last = known[known.length - 1];
    return (
      <svg
        className={styles.spark}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        role="img"
        aria-label={lang('PlannerHealthWeightChart')}
        data-health-weight
      >
        {goal !== undefined && (
          <line className={styles.sparkGoal} x1="0" x2={SPARK_WIDTH} y1={y(goal)} y2={y(goal)} />
        )}
        {goal !== undefined && (
          <text className={styles.sparkLabel} x={SPARK_WIDTH - SPARK_PAD} y={y(goal) - SPARK_PAD} text-anchor="end">
            {goalLabel(number(goal, 1))}
          </text>
        )}
        <polyline
          className={styles.sparkLine}
          points={known.map((point) => `${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')}
        />
        <circle className={styles.sparkDot} cx={x(last.index)} cy={y(last.value)} r={SPARK_DOT} />
      </svg>
    );
  };

  // Ночи двух недель столбиками от отхода ко сну до подъёма. Ось времени — вокруг средней середины сна,
  // поэтому ночь не рвётся на полуночи. Сплошные линии — среднее, пунктир — цель, точка — ночь без времени
  const renderRoutineChart = () => {
    const { days, nights, center } = routine;
    if (!nights.length) return undefined;
    const offset = (clock: number) => clockDifference(clock, center || 0);
    const spans = nights.filter((night) => night.bed !== undefined).map((night) => {
      const middle = offset(night.midpoint!);
      const half = wrapClock(night.wake! - night.bed!) / 2;
      return { night, from: middle - half, to: middle + half };
    });
    const means = routine.bed && routine.wake ? [routine.bed.mean, routine.wake.mean] : [];
    const goalLines = spans.length && routineGoal ? [goalBed!, goalWake!] : [];
    const marks = [...spans.flatMap(({ from, to }) => [from, to]), ...[...means, ...goalLines].map(offset)];
    const low = marks.length
      ? Math.floor((Math.min(...marks) - ROUTINE_AXIS_PAD) / MINUTES_IN_HOUR) * MINUTES_IN_HOUR : -ROUTINE_EMPTY_SPAN;
    const high = marks.length
      ? Math.ceil((Math.max(...marks) + ROUTINE_AXIS_PAD) / MINUTES_IN_HOUR) * MINUTES_IN_HOUR : ROUTINE_EMPTY_SPAN;
    const plotWidth = ROUTINE_WIDTH - ROUTINE_GUTTER;
    const column = plotWidth / days.length;
    const x = (key: string) => days.indexOf(key) * column;
    const y = (value: number) => (
      ROUTINE_PAD + ((value - low) / (high - low)) * (ROUTINE_HEIGHT - ROUTINE_PAD * 2)
    );
    // Подписи справа: средние времена, а пока их нет — границы оси
    const labels = means.length
      ? means.map((clock) => ({ at: offset(clock), text: toTime(wrapClock(roundToStep(clock))) }))
      : spans.length ? [low, high].map((at) => ({ at, text: toTime(wrapClock(center! + at)) })) : [];
    const barTone = ({ deviation }: SleepNight) => (
      deviation === undefined || deviation <= SLEEP_ROUTINE_STABLE_SPREAD ? undefined
        : deviation <= SLEEP_ROUTINE_DRIFTING_SPREAD ? styles.routineBarDrift : styles.routineBarOff
    );
    return (
      <div>
        <svg
          className={styles.routineChart}
          viewBox={`0 0 ${ROUTINE_WIDTH} ${ROUTINE_HEIGHT}`}
          role="img"
          aria-label={lang('PlannerSleepRoutineChart')}
          data-sleep-routine-chart
        >
          {goalLines.map((clock, index) => (
            <line
              key={`goal-${index === 0 ? 'bed' : 'wake'}`}
              className={styles.routineGoal}
              x1="0"
              x2={plotWidth}
              y1={y(offset(clock)).toFixed(1)}
              y2={y(offset(clock)).toFixed(1)}
              data-sleep-routine-goal-line
            />
          ))}
          {spans.map(({ night, from, to }) => (
            <rect
              key={night.day}
              className={buildClassName(
                styles.routineBar, barTone(night), night.day === day && styles.routineBarCurrent,
              )}
              x={(x(night.day) + (column * (1 - ROUTINE_BAR_SHARE)) / 2).toFixed(1)}
              y={y(from).toFixed(1)}
              width={(column * ROUTINE_BAR_SHARE).toFixed(1)}
              height={(y(to) - y(from)).toFixed(1)}
              rx={ROUTINE_BAR_RADIUS}
              data-sleep-night={night.day}
              data-sleep-night-kind="timed"
            />
          ))}
          {nights.filter((night) => night.bed === undefined).map((night) => (
            <circle
              key={night.day}
              className={styles.routineDot}
              cx={(x(night.day) + column / 2).toFixed(1)}
              cy={ROUTINE_HEIGHT / 2}
              r={ROUTINE_DOT}
              data-sleep-night={night.day}
              data-sleep-night-kind="untimed"
            />
          ))}
          {means.map((clock, index) => (
            <line
              key={`mean-${index === 0 ? 'bed' : 'wake'}`}
              className={styles.routineMean}
              x1="0"
              x2={plotWidth}
              y1={y(offset(clock)).toFixed(1)}
              y2={y(offset(clock)).toFixed(1)}
            />
          ))}
          {labels.map(({ at, text }, index) => (
            <text
              key={index === 0 ? 'top' : 'bottom'}
              className={styles.routineLabel}
              x={ROUTINE_WIDTH}
              y={(y(at) + ROUTINE_LABEL_SHIFT).toFixed(1)}
              text-anchor="end"
            >
              {text}
            </text>
          ))}
        </svg>
        <div className={styles.routineDays}>
          {days.map((key) => (
            <span key={key} className={buildClassName(styles.routineDay, key === day && styles.routineDayCurrent)}>
              {fromDayKey(key).getDate()}
            </span>
          ))}
        </div>
      </div>
    );
  };

  // «Режим сна»: одинаково ли время отхода ко сну и подъёма изо дня в день
  const renderRoutine = () => {
    const {
      level, bed, wake, spread, timedCount, untimedCount, outliers, socialJetlag, bedGoalDeviation, wakeGoalDeviation,
    } = routine;
    const { label, tone } = ROUTINE_LEVELS[level];
    const minutes = (value: number) => lang('PlannerMinutesValue', { minutes: value });
    const toGoal = (deviation: number, goal: string) => (
      Math.abs(deviation) < ON_GOAL_MINUTES ? lang('PlannerSleepRoutineOnGoal', { goal })
        : lang(deviation > 0 ? 'PlannerSleepRoutineLater' : 'PlannerSleepRoutineEarlier', {
          value: formatDuration(lang, roundToStep(Math.abs(deviation))), goal,
        })
    );
    const goalParts = routineGoal && bedGoalDeviation !== undefined && wakeGoalDeviation !== undefined ? [
      lang('PlannerSleepRoutineBedGoal', { value: toGoal(bedGoalDeviation, routineGoal.bed) }),
      lang('PlannerSleepRoutineWakeGoal', { value: toGoal(wakeGoalDeviation, routineGoal.wake) }),
    ] : [];
    // Сдвиг выходных меньше получаса — не повод для строки
    const jetlag = socialJetlag !== undefined && Math.abs(socialJetlag) >= SLEEP_ROUTINE_STABLE_SPREAD
      ? socialJetlag : undefined;
    return (
      <div
        className={styles.stack}
        data-health="sleep-routine"
        data-sleep-routine-level={level}
        data-sleep-routine-spread={spread}
      >
        <div className={styles.cardHead}>
          <h4 className={buildClassName(styles.groupTitle, styles.groupTitleFirst)}>{lang('PlannerSleepRoutine')}</h4>
          <span className={styles.grow} />
          {routineGoal && (
            <span className={styles.cardNote} data-sleep-routine-goal>
              {goalLabel(`${routineGoal.bed}–${routineGoal.wake}`)}
            </span>
          )}
          <span className={buildClassName(styles.tag, tone)} data-sleep-routine-chip>{lang(label)}</span>
        </div>
        {bed && wake ? (
          <p className={styles.cardText} data-sleep-routine-summary>
            {lang('PlannerSleepRoutineSummary', {
              bed: toTime(wrapClock(roundToStep(bed.mean))),
              bedSpread: minutes(bed.spread),
              wake: toTime(wrapClock(roundToStep(wake.mean))),
              wakeSpread: minutes(wake.spread),
            })}
          </p>
        ) : (
          <p className={styles.cardText} data-sleep-routine-hint>
            {lang('PlannerSleepRoutineHint', { count: timedCount, min: SLEEP_ROUTINE_MIN_NIGHTS })}
          </p>
        )}
        {Boolean(goalParts.length) && (
          <p className={styles.cardText} data-sleep-routine-deviation>{goalParts.join(' · ')}</p>
        )}
        {renderRoutineChart()}
        {Boolean(outliers.length) && (
          <p className={styles.cardText} data-sleep-routine-outliers>
            {lang('PlannerSleepRoutineOutliers', {
              nights: outliers.map((night) => (
                `${formatDayShort(lang, night.day)} ${toTime(night.bed!)} → ${toTime(night.wake!)}`
              )).join(', '),
            })}
          </p>
        )}
        {jetlag !== undefined && (
          <p className={styles.cardText} data-sleep-routine-jetlag>
            {lang(jetlag > 0 ? 'PlannerSleepRoutineJetlagLater' : 'PlannerSleepRoutineJetlagEarlier', {
              value: formatDuration(lang, roundToStep(Math.abs(jetlag))),
            })}
          </p>
        )}
        {Boolean(untimedCount) && (
          <p className={styles.cardText} data-sleep-routine-untimed={untimedCount}>
            {lang('PlannerSleepRoutineUntimed', { count: untimedCount })}
          </p>
        )}
        {Boolean(routine.nights.length) && <p className={styles.small}>{lang('PlannerSleepRoutineLegend')}</p>}
        {!routineGoal && (
          <div className={styles.chips}>
            <span className={styles.cardText}>{lang('PlannerSleepRoutineGoalHint')}</span>
            <button type="button" className={styles.chip} data-sleep-routine-goal-example onClick={handleRoutineGoal}>
              {lang('PlannerSleepRoutineGoalExample')}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderFact = (label: string, value: string | undefined, isAccent?: boolean) => (
    <span className={styles.healthFact}>
      <span className={styles.healthFactLabel}>{label}</span>
      <span className={buildClassName(styles.healthFactValue, !value && styles.faint, isAccent && styles.kindNote)}>
        {value || '—'}
      </span>
    </span>
  );

  return (
    <div className={styles.health} data-planner-health={day}>
      <section className={buildClassName(styles.card, styles.stack, styles.healthWide)} data-health="hint">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerHealthHintTitle')}</h3>
          <span className={styles.grow} />
          <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onOpenSettings}>
            <Icon name="settings" />
            {lang('PlannerHealthGoalsShort')}
          </button>
        </div>
        <p className={styles.cardText}>{lang('PlannerHealthHint')}</p>
        <div className={styles.chips}>
          {examples.map((text) => (
            <button key={text} type="button" className={styles.chip} data-text={text} onClick={handleExample}>
              {text}
            </button>
          ))}
        </div>
      </section>

      <section className={buildClassName(styles.card, styles.stack)} data-health="nutrition">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerHealthNutrition')}</h3>
          <span className={styles.grow} />
          {Boolean(kcalGoal) && <span className={styles.cardNote}>{goalLabel(number(kcalGoal))}</span>}
        </div>
        <div className={styles.healthBig}>
          <span className={buildClassName(styles.big, isKcalOver ? styles.kindDue : styles.kindFood)}>
            {number(kcal)}
          </span>
          <span className={styles.muted}>
            {lang('PlannerHealthKcal', { value: '' }).trim()}
            {kcalGoal ? ` · ${isKcalOver
              ? lang('PlannerHealthKcalOver', { value: number(kcal - kcalGoal) })
              : lang('PlannerHealthKcalLeft', { value: number(kcalGoal - kcal) })}` : ''}
          </span>
        </div>
        <span className={buildClassName(styles.prog, styles.progThick, isKcalOver ? styles.kindDue : styles.kindFood)}>
          <span className={styles.progFill} style={`width: ${share(kcal, kcalGoal)}%`} />
        </span>
        <label className={buildClassName(styles.row, styles.rowButton)}>
          <input
            type="checkbox"
            className={buildClassName(styles.check, styles.checkGreen)}
            checked={isClosed}
            onChange={handleToggleClosed}
          />
          <span>{lang(isClosed ? 'PlannerHealthDayClosedHint' : 'PlannerHealthCloseDay')}</span>
        </label>
        <div className={styles.macros}>
          {MACROS.map(({ nutrient, label, kind }) => {
            const value = total(nutrient);
            const goal = goals[nutrient]?.target;
            return renderMacro(
              lang(label),
              number(value),
              goal ? lang('PlannerHealthGrams', { value: '', goal: number(goal) })
                : lang('PlannerHealthGramsNoGoal', { value: '' }),
              share(value, goal),
              kind,
            );
          })}
          {LIMITS.map(({
            nutrient, label, goal, kind,
          }) => {
            const value = getLimitTotal(state, day, nutrient);
            const limit = healthGoals[goal];
            return renderMacro(
              lang(label),
              number(value, 1),
              limit ? lang('PlannerHealthLimit', { value: '', goal: number(limit, 1) })
                : lang('PlannerHealthGramsNoGoal', { value: '' }),
              share(value, limit),
              limit && value > limit ? styles.kindDue : kind,
            );
          })}
        </div>
        <div>
          {!entries.length && <p className={styles.muted}>{lang('PlannerHealthNoMeals')}</p>}
          {entries.map(renderMeal)}
        </div>
      </section>

      <section className={buildClassName(styles.card, styles.stack)}>
        <div className={styles.stack} data-health="water">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>{lang('PlannerHealthWater')}</h3>
            <span className={styles.grow} />
            {Boolean(waterGoal) && <span className={styles.cardNote}>{goalLabel(litres(waterGoal))}</span>}
          </div>
          <div className={styles.healthBig}>
            <span className={buildClassName(styles.big, styles.kindEvent)}>{number(waterMl / ML_IN_LITRE, 2)}</span>
            <span className={styles.muted}>{lang('PlannerHealthLitres', { value: '' }).trim()}</span>
          </div>
          <span className={buildClassName(styles.prog, styles.progThick, styles.kindEvent)}>
            <span className={styles.progFill} style={`width: ${share(waterMl, waterGoal)}%`} />
          </span>
          <div className={styles.chips}>
            <button type="button" className={styles.chip} data-ml={GLASS_ML} onClick={handleWater}>
              {lang('PlannerHealthAddGlass')}
            </button>
            <button type="button" className={styles.chip} data-ml={BOTTLE_ML} onClick={handleWater}>
              {lang('PlannerHealthAddBottle')}
            </button>
          </div>
        </div>
        <div className={styles.stack} data-health="body">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>{lang('PlannerHealthBody')}</h3>
            <span className={styles.grow} />
            {Boolean(healthGoals.weight) && (
              <span className={styles.cardNote}>
                {goalLabel(lang('PlannerHealthKg', { value: number(healthGoals.weight, 1) }))}
              </span>
            )}
          </div>
          <div className={styles.healthBig}>
            <span className={buildClassName(styles.big, styles.kindWorkout)}>
              {weight ? number(weight.value, 1) : '—'}
            </span>
            <span className={styles.muted}>
              {lang('PlannerHealthKg', { value: '' }).trim()}
              {weightChange !== undefined ? ` · ${lang('PlannerHealthWeekChange', {
                value: `${weightChange > 0 ? '+' : ''}${number(weightChange, 1)}`,
              })}` : ''}
            </span>
          </div>
          {renderWeight()}
          <div className={styles.healthFacts}>
            {renderFact(
              lang('PlannerHealthPressure'), pressure ? `${pressure.value}/${pressure.value2 || 0}` : undefined,
            )}
            {renderFact(
              lang('PlannerHealthPulse'), pulse ? lang('PlannerHealthBpm', { value: number(pulse.value) }) : undefined,
            )}
            {renderFact(lang('PlannerHealthMood'), mood ? number(mood.value) : undefined, true)}
          </div>
        </div>
      </section>

      <section className={buildClassName(styles.card, styles.stack)} data-health="sleep">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerHealthSleep')}</h3>
          <span className={styles.grow} />
          {sleepAverage !== undefined && (
            <span className={styles.cardNote}>
              {lang('PlannerHealthSleepAverage', { value: formatSpan(sleepAverage) })}
            </span>
          )}
        </div>
        {sleep ? (
          <div className={styles.healthBig}>
            <span className={buildClassName(styles.big, isShortNight ? styles.kindDue : styles.kindSleep)}>
              {formatSpan(sleep.value)}
            </span>
            <span className={styles.muted}>
              {sleep.time && sleep.endTime ? `${sleep.time} → ${sleep.endTime}` : ''}
            </span>
          </div>
        ) : (
          <button type="button" className={styles.btn} onClick={handleAddSleep}>
            {lang('PlannerHealthSleepAdd')}
          </button>
        )}
        <HealthTextForm
          id="planner-health-sleep"
          placeholder={lang('PlannerHealthSleepDayPlaceholder')}
          label={lang('PlannerHealthSleepDayLabel')}
          buttonText={lang('Save')}
          buttonClassName={styles.btn}
          onSubmit={handleSleepSubmit}
        />
        {renderBars(
          sleepSeries, formatSpan, 'sleep', styles.kindSleep, healthGoals.sleepMinutes,
          (value) => value < SHORT_SLEEP_MINUTES,
        )}
        <p className={styles.cardText}>
          {lang('PlannerHealthSleepShort', { hours: SHORT_SLEEP_MINUTES / MINUTES_IN_HOUR })}
        </p>
        {renderRoutine()}
      </section>

      <section className={buildClassName(styles.card, styles.stack)} data-health="activity">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerHealthActivity')}</h3>
          <span className={styles.grow} />
          <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={handleAddWorkout}>
            <Icon name="add" />
            {lang('PlannerKindWorkout')}
          </button>
        </div>
        {renderProgress(
          lang('PlannerHealthSteps'),
          number(steps),
          healthGoals.steps ? ` / ${number(healthGoals.steps)}` : '',
          share(steps, healthGoals.steps),
          styles.kindWorkout,
        )}
        {renderProgress(
          lang('PlannerHealthActiveMinutes'),
          number(activeMinutes),
          healthGoals.activeMinutes
            ? ` / ${lang('PlannerHealthMinutes', { value: number(healthGoals.activeMinutes) })}`
            : ` ${lang('PlannerHealthMinutes', { value: '' }).trim()}`,
          share(activeMinutes, healthGoals.activeMinutes),
          styles.kindFood,
        )}
        {renderProgress(
          lang('PlannerHealthWorkouts'),
          String(workouts.length),
          healthGoals.workouts ? ` / ${healthGoals.workouts}` : '',
          share(workouts.length, healthGoals.workouts),
          styles.kindEvent,
        )}
        {renderBars(stepSeries, formatSteps, 'steps', styles.kindWorkout, healthGoals.steps)}
        <div>
          {!workouts.length && <p className={styles.muted}>{lang('PlannerHealthNoWorkouts')}</p>}
          {workouts.map(renderWorkout)}
        </div>
        <p className={styles.cardText}>{lang('PlannerHealthActivityHint')}</p>
      </section>

      <section className={buildClassName(styles.card, styles.stack)} data-health="kcal-week">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerHealthKcalWeek')}</h3>
          <span className={styles.grow} />
          {kcalAverage !== undefined && (
            <span className={styles.cardNote}>
              {lang('PlannerHealthSleepAverage', { value: number(kcalAverage) })}
            </span>
          )}
        </div>
        {renderBars(kcalSeries, (value) => number(value), 'kcal', styles.kindFood, kcalGoal)}
      </section>

      <section className={buildClassName(styles.card, styles.stack)} data-health="goals">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerHealthGoals')}</h3>
        </div>
        <p className={styles.cardText} data-health-goals-summary>
          {[
            kcalGoal ? lang('PlannerHealthKcal', { value: number(kcalGoal) }) : undefined,
            ...MACROS.map(({ nutrient, label }) => (
              goals[nutrient] ? `${lang(label)} ${number(goals[nutrient].target)}` : undefined
            )),
            waterGoal ? `${lang('PlannerHealthWater')} ${litres(waterGoal)}` : undefined,
            healthGoals.sleepMinutes
              ? `${lang('PlannerHealthSleep')} ${formatSpan(healthGoals.sleepMinutes)}` : undefined,
            routineGoal ? lang('PlannerSleepRoutineGoalShort', routineGoal) : undefined,
            healthGoals.steps ? `${lang('PlannerHealthStepsShort')} ${number(healthGoals.steps)}` : undefined,
            lang('PlannerHealthDayWindow', {
              from: toTime(state.settings.dayStart),
              to: toTime(state.settings.dayEnd),
              budget: formatHours(lang, state.budget),
            }),
          ].filter(Boolean).join(' · ')}
        </p>
        <HealthTextForm
          id="planner-health-goals"
          placeholder={lang('PlannerHealthGoalsPlaceholder')}
          label={lang('PlannerHealthGoalsText')}
          buttonText={lang('PlannerHealthGoalsApply')}
          buttonClassName={buildClassName(styles.btn, styles.btnAccent)}
          onSubmit={handleGoalSubmit}
        />
      </section>
    </div>
  );
};

export default memo(PlannerHealth);
