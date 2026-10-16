import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { SleepNight } from './plannerHealth';
import type {
  PlannerFoodEntry, PlannerHealthRecord, PlannerMetric, PlannerNutrient, PlannerState,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayShort, formatDuration, formatHours, formatNumber, formatSpan, formatWeekday,
} from './plannerFormat';
import {
  applyQuickDraft, formatPace, getBedOffset, getClockGoal, getDailyRecord, getDailySeries, getLastDays,
  getLatestRecord, getLimitTotal, getSleepAxis, getSleepRecords, getSleepRoutine, getSleepSpan, getWorkouts,
  SHORT_SLEEP_MINUTES,
  SLEEP_ROUTINE_DRIFTING_SPREAD, SLEEP_ROUTINE_MIN_NIGHTS, SLEEP_ROUTINE_STABLE_SPREAD, sumActiveMinutes, wrapClock,
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
  // `goals` — только цели и их правка текстом (окно «Настройки здоровья» за шестерёнкой экрана), иначе экран
  mode?: 'goals';
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
  // Подставить текст в поле (правка записанного): подставляется при каждом новом `fill.key`
  fill?: { key: number; text: string };
  // `true` — строка принята, поле очищается
  onSubmit: (text: string) => boolean;
};

// Строка ввода с кнопкой («сон дня», «цели»): набираемый текст — состояние поля, а не экрана, иначе каждый
// символ перерисовывал бы весь экран «Здоровья»
const HealthTextForm = memo(({
  id, placeholder, label, buttonText, buttonClassName, fill, onSubmit,
}: TextFormProps) => {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>();

  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    inputRef.current?.focus();
  }, [fill]);

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
        ref={inputRef}
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
  state, day, today, onExample, onOpenSettings, mode,
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
  const sleeps = getSleepRecords(state, day);
  const isShortNight = sleep ? sleep.value < SHORT_SLEEP_MINUTES : false;
  const sleepSeries = useMemo(() => getDailySeries(state, 'sleep', week), [state, week]);
  const knownSleep = sleepSeries.filter((value): value is number => value !== undefined);
  const sleepAverage = knownSleep.length ? knownSleep.reduce((a, b) => a + b, 0) / knownSleep.length : undefined;
  const routine = useMemo(() => getSleepRoutine(state, day), [state, day]);
  // День графика режима, выбранный нажатием; без выбора — день экрана
  const [pickedSleepDay, setPickedSleepDay] = useState<string>();
  // Цель режима — минуты от полуночи: полночь (ноль) — тоже цель
  const goalBed = getClockGoal(healthGoals.bedtime);
  const goalWake = getClockGoal(healthGoals.wakeTime);
  const routineGoal = goalBed !== undefined && goalWake !== undefined
    ? { bed: toTime(goalBed), wake: toTime(goalWake) } : undefined;

  const steps = getDailyRecord(state, 'steps', day)?.value || 0;
  const stepSeries = useMemo(() => getDailySeries(state, 'steps', week), [state, week]);
  const workouts = useMemo(() => getWorkouts(state, week), [state, week]);
  const activeMinutes = useMemo(() => sumActiveMinutes(workouts), [workouts]);

  // Чип-пример вставляется в поле как текст (пробел в конце — признак начала строки, а не примера вида)
  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(`${e.currentTarget.dataset.text!} `);
  });

  const handleAddSleep = useLastCallback(() => {
    onExample(lang('PlannerHealthSleepExample'));
  });

  const handleSleepPick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPickedSleepDay(e.currentTarget.dataset.sleepPick);
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
    const replaceId = editingSleepId;
    updatePlanner((next) => {
      applyQuickDraft(next, draft, day, replaceId);
    }, replaceId
      ? lang('PlannerNoticeSleepUpdated')
      : lang('PlannerNoticeAdded', { name: lang('PlannerHealthSleep') }));
    setEditingSleepId(undefined);
    return true;
  });

  // Сны дня (ночь и дневной): «Изменить» — строка этого сна в поле, сохранение меняет его; «Удалить» — только его
  const [sleepFill, setSleepFill] = useState<{ key: number; text: string }>();
  const [editingSleepId, setEditingSleepId] = useState<string>();

  const handleEditSleep = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const record = sleeps.find(({ id }) => id === e.currentTarget.dataset.sleepId);
    if (!record) return;
    const text = record.time && record.endTime
      ? `${record.time}–${record.endTime}`
      : lang('PlannerHealthSleepHours', { hours: formatNumber(lang, record.value / MINUTES_IN_HOUR, 2) });
    setEditingSleepId(record.id);
    setSleepFill({ key: Date.now(), text });
  });

  const handleDeleteSleep = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { sleepId } = e.currentTarget.dataset;
    updatePlanner((draft) => {
      draft.health = draft.health.filter(({ id }) => id !== sleepId);
    }, lang('PlannerNoticeSleepDeleted'));
    if (editingSleepId === sleepId) setEditingSleepId(undefined);
  });

  // Нажатие на значение (вода, вес, давление…) — ввод текстом для этого показателя
  const handleValueClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(e.currentTarget.dataset.example!);
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
                value === 0 && styles.barsColumnZero,
                week[index] === day && styles.barsColumnCurrent,
              )}
              data-bar-zero={value === 0 ? '' : undefined}
            >
              {/* Записанный ноль («не спал») — красная отметка с подписью, нет данных — прочерк */}
              <span className={styles.barsValue}>{value !== undefined ? format(value) : '—'}</span>
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

  // Сны двух недель столбиками на шкале часов. Сон через полночь начинается накануне вечером, остальные — в свой
  // день; самый долгий сон дня (по нему считается режим) — ярче, прочие — бледнее. Сплошные линии — среднее,
  // пунктир — цель, точка — сон без времени. Нажатие на день — его сны строкой под графиком
  const renderRoutineChart = () => {
    const { days, nights } = routine;
    if (!nights.length) return undefined;
    const selected = pickedSleepDay && days.includes(pickedSleepDay) ? pickedSleepDay : day;
    const columns = days.map((key) => {
      const records = getSleepRecords(state, key);
      const mainId = getDailyRecord(state, 'sleep', key)?.id;
      const night = nights.find((item) => item.day === key);
      const spans = records.map((record) => ({ record, span: getSleepSpan(record), isMain: record.id === mainId }));
      return {
        key, night, records, spans: spans.filter(({ span }) => span),
      };
    });
    const means = routine.bed && routine.wake ? [getBedOffset(routine.bed.mean), routine.wake.mean] : [];
    const goalLines = routineGoal ? [getBedOffset(goalBed!), goalWake!] : [];
    const axis = getSleepAxis([
      ...columns.flatMap(({ spans }) => spans.flatMap(({ span }) => [span!.from, span!.to])), ...means, ...goalLines,
    ]);
    const at = (value: number) => (((value - axis.low) / (axis.high - axis.low)) * PERCENT).toFixed(2);
    const barTone = (night?: SleepNight) => (
      night?.deviation === undefined || night.deviation <= SLEEP_ROUTINE_STABLE_SPREAD ? undefined
        : night.deviation <= SLEEP_ROUTINE_DRIFTING_SPREAD ? styles.routineBarDrift : styles.routineBarOff
    );
    const picked = columns.find(({ key }) => key === selected)!;
    return (
      <div className={styles.stack}>
        <div
          className={styles.routineChart}
          role="group"
          aria-label={lang('PlannerSleepRoutineChart')}
          data-sleep-routine-chart
        >
          <div className={styles.routineLayer}>
            {axis.ticks.map((tick) => (
              <span
                key={tick}
                className={buildClassName(styles.routineGrid, wrapClock(tick) === 0 && styles.routineMidnight)}
                style={`top: ${at(tick)}%`}
              />
            ))}
          </div>
          <div className={styles.routineTicks} aria-hidden>
            {axis.ticks.map((tick) => (
              <span key={tick} className={styles.routineTick} style={`top: ${at(tick)}%`}>
                {toTime(wrapClock(tick))}
              </span>
            ))}
          </div>
          <div className={styles.routineColumns}>
            {columns.map(({ key, night, spans }) => (
              <button
                key={key}
                type="button"
                className={buildClassName(styles.routineColumn, key === selected && styles.routineColumnPicked)}
                aria-pressed={key === selected}
                aria-label={formatDayShort(lang, key)}
                data-sleep-pick={key}
                onClick={handleSleepPick}
              >
                <span className={styles.routineTrack}>
                  {spans.map(({ record, span, isMain }) => (
                    <span
                      key={record.id}
                      className={buildClassName(styles.routineBar, isMain ? barTone(night) : styles.routineBarNap)}
                      style={`top: ${at(span!.from)}%; bottom: ${(PERCENT - Number(at(span!.to))).toFixed(2)}%`}
                      title={`${record.time} → ${record.endTime} · ${formatSpan(record.value)}`}
                      data-sleep-night={key}
                      data-sleep-night-kind={isMain ? 'timed' : 'nap'}
                    />
                  ))}
                  {night && night.bed === undefined && (
                    <span className={styles.routineDot} data-sleep-night={key} data-sleep-night-kind="untimed" />
                  )}
                </span>
                <span className={buildClassName(styles.routineDay, key === day && styles.routineDayCurrent)}>
                  {fromDayKey(key).getDate()}
                </span>
              </button>
            ))}
          </div>
          <div className={styles.routineLayer}>
            {goalLines.map((value, index) => (
              <span
                key={`goal-${index === 0 ? 'bed' : 'wake'}`}
                className={styles.routineGoal}
                style={`top: ${at(value)}%`}
                data-sleep-routine-goal-line
              />
            ))}
            {means.map((value, index) => (
              <span
                key={`mean-${index === 0 ? 'bed' : 'wake'}`}
                className={styles.routineMean}
                style={`top: ${at(value)}%`}
              />
            ))}
          </div>
        </div>
        <p className={styles.cardText} data-sleep-routine-detail={selected}>
          {renderSleepDetail(picked.key, picked.records)}
        </p>
      </div>
    );
  };

  // Сны дня строкой: «16 окт: 05:40 → 08:40 (3:00), 21:00 → 22:10 (1:10) · всего 4:10»
  const renderSleepDetail = (key: string, records: PlannerHealthRecord[]) => {
    const dayLabel = formatDayShort(lang, key);
    if (!records.length) return lang('PlannerSleepRoutineDetailNone', { day: dayLabel });
    const sorted = [...records].sort((a, b) => (getSleepSpan(a)?.from ?? 0) - (getSleepSpan(b)?.from ?? 0));
    const sleepText = sorted.map((record) => (getSleepSpan(record)
      ? `${record.time} → ${record.endTime} (${formatSpan(record.value)})`
      : lang('PlannerSleepRoutineDetailUntimed', { value: formatSpan(record.value) }))).join(', ');
    if (records.length < 2) return lang('PlannerSleepRoutineDetail', { day: dayLabel, sleeps: sleepText });
    const sum = formatSpan(records.reduce((minutes, record) => minutes + record.value, 0));
    return lang('PlannerSleepRoutineDetailTotal', { day: dayLabel, sleeps: sleepText, total: sum });
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

  // Показатель — кнопка: ввод текстом под него (пример — подсказкой, подсказки — этого показателя)
  const renderFact = (label: string, value: string | undefined, example: string, isAccent?: boolean) => (
    <button
      type="button"
      className={buildClassName(styles.healthFact, styles.healthValueButton)}
      data-example={example}
      onClick={handleValueClick}
    >
      <span className={styles.healthFactLabel}>{label}</span>
      <span className={buildClassName(styles.healthFactValue, !value && styles.faint, isAccent && styles.kindNote)}>
        {value || '—'}
      </span>
    </button>
  );

  const goalsSection = (
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
  );

  if (mode === 'goals') return goalsSection;

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
          <button
            type="button"
            className={buildClassName(styles.healthBig, styles.healthValueButton)}
            data-health-value="water"
            data-example={lang('PlannerHealthWaterExample')}
            onClick={handleValueClick}
          >
            <span className={buildClassName(styles.big, styles.kindEvent)}>{number(waterMl / ML_IN_LITRE, 2)}</span>
            <span className={styles.muted}>{lang('PlannerHealthLitres', { value: '' }).trim()}</span>
          </button>
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
          <button
            type="button"
            className={buildClassName(styles.healthBig, styles.healthValueButton)}
            data-health-value="weight"
            data-example={lang('PlannerHealthWeightExample')}
            onClick={handleValueClick}
          >
            <span className={buildClassName(styles.big, styles.kindWorkout)}>
              {weight ? number(weight.value, 1) : '—'}
            </span>
            <span className={styles.muted}>
              {lang('PlannerHealthKg', { value: '' }).trim()}
              {weightChange !== undefined ? ` · ${lang('PlannerHealthWeekChange', {
                value: `${weightChange > 0 ? '+' : ''}${number(weightChange, 1)}`,
              })}` : ''}
            </span>
          </button>
          {renderWeight()}
          <div className={styles.healthFacts}>
            {renderFact(
              lang('PlannerHealthPressure'), pressure ? `${pressure.value}/${pressure.value2 || 0}` : undefined,
              lang('PlannerHealthPressureExample'),
            )}
            {renderFact(
              lang('PlannerHealthPulse'), pulse ? lang('PlannerHealthBpm', { value: number(pulse.value) }) : undefined,
              lang('PlannerHealthPulseExample'),
            )}
            {renderFact(
              lang('PlannerHealthMood'), mood ? number(mood.value) : undefined, lang('PlannerHealthMoodExample'), true,
            )}
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
          <>
            <div className={styles.healthBig}>
              <span className={buildClassName(styles.big, isShortNight ? styles.kindDue : styles.kindSleep)}>
                {formatSpan(sleep.value)}
              </span>
            </div>
            {sleeps.map((record) => (
              <div key={record.id} className={styles.sleepRow} data-sleep-record={record.id}>
                <span className={styles.sleepRowTime}>
                  {record.time && record.endTime ? `${record.time} → ${record.endTime}` : '—'}
                </span>
                <span className={styles.muted}>{formatSpan(record.value)}</span>
                <span className={styles.grow} />
                <button
                  type="button"
                  className={buildClassName(styles.ib, editingSleepId === record.id && styles.ibActive)}
                  aria-label={lang('Edit')}
                  data-sleep-edit
                  data-sleep-id={record.id}
                  onClick={handleEditSleep}
                >
                  <Icon name="edit" />
                </button>
                <button
                  type="button"
                  className={styles.ib}
                  aria-label={lang('Delete')}
                  data-sleep-delete
                  data-sleep-id={record.id}
                  onClick={handleDeleteSleep}
                >
                  <Icon name="delete" />
                </button>
              </div>
            ))}
          </>
        ) : (
          <button type="button" className={styles.btn} onClick={handleAddSleep}>
            {lang('PlannerHealthSleepAdd')}
          </button>
        )}
        <HealthTextForm
          id="planner-health-sleep"
          fill={sleepFill}
          placeholder={lang('PlannerHealthSleepDayPlaceholder')}
          label={lang(editingSleepId ? 'PlannerHealthSleepEditLabel' : 'PlannerHealthSleepDayLabel')}
          buttonText={lang(editingSleepId ? 'Save' : 'PlannerHealthSleepAddShort')}
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

    </div>
  );
};

export default memo(PlannerHealth);
