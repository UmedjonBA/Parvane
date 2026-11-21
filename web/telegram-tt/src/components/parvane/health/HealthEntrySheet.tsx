import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { HealthExtraForm } from './healthDayFormat';
import type { HealthDraft, HealthEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatDate } from '../planner/plannerFormat';
import {
  EMPTY_EXTRA_FORM, extraDraftOf, extraFormOf, FOOD_KIND, hasExtraFields, MEALS, mealTitleKey, WORKOUT_KIND,
  WORKOUT_TAGS, workoutTitleKey,
} from './healthDayFormat';
import {
  buildSleepSpan, formatClock, fromLocalParts, NO_SLEEP_TAG, parseClock, parseNumber, SLEEP_ASIDE_TAG, toLocalParts,
} from './healthFormat';
import {
  addHealthEntries, checkHealthEntry, deleteHealthEntry, saveHealthEntry,
} from './healthStore';
import useHealthLabels from './useHealthLabels';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';
import PvSwitch from '../notes/PvSwitch';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

// Что открыто в окне: правка записи либо новый дневной сон на этот день
// `isNew` — запись ещё не сохранена: поля заполнены разбором строки («Изменить» в шторке «Запись в здоровье»)
export type HealthSheetTarget = { entry?: HealthEntry; napDay?: string; isNew?: boolean };

type OwnProps = {
  target?: HealthSheetTarget;
  today: string;
  // Цель длительности сна: окно ночи показывает отклонение
  goalMinutes?: number;
  // Компьютер: кнопки в ряд «Удалить запись · Отмена · Сохранить» (доска `ZdHealthX`); телефон — столбиком
  isWide?: boolean;
  onNap: (day: string) => void;
  onClose: NoneToVoidFunction;
};

type Form = HealthExtraForm & {
  value: string;
  value2: string;
  day: string;
  time: string;
  endTime: string;
  note: string;
};

const EMPTY_FORM: Form = {
  ...EMPTY_EXTRA_FORM, value: '', value2: '', day: '', time: '', endTime: '', note: '',
};
const NAP_FROM = '14:00';
const NAP_TO = '15:00';
const NIGHT_FROM = '23:00';
const NAP_MAX_MS = 4 * 60 * 60 * 1000;
const NIGHT_TO = '07:00';
// Заголовок окна: «Запись веса»; вид без своего заголовка — «Запись: <вид>»
const TITLE_KEYS: Record<string, string> = {
  weight: 'HealthEntryTitleWeight',
  pressure: 'HealthEntryTitlePressure',
  pulse: 'HealthEntryTitlePulse',
  steps: 'HealthEntryTitleSteps',
  mood: 'HealthEntryTitleMood',
  water: 'HealthEntryTitleWater',
  food: 'HealthEntryTitleFood',
  workout: 'HealthEntryTitleWorkout',
  sleep_start: 'HealthEntryTitleMark',
  sleep_end: 'HealthEntryTitleMark',
};
// «Ночь на субботу»: день недели пробуждения, 0 — понедельник
const NIGHT_KEYS = [
  'HealthNightMon', 'HealthNightTue', 'HealthNightWed', 'HealthNightThu', 'HealthNightFri', 'HealthNightSat',
  'HealthNightSun',
] as const;
const DATE_LONG = { day: 'numeric', month: 'long' } as const;
const NOTE_MAX = 500;
const NAME_MAX = 120;
const DECIMAL = { inputMode: 'decimal' } as const;
const PROBLEM_KEYS = {
  value: 'HealthFormProblemValue',
  future: 'HealthFormProblemFuture',
  span: 'HealthFormProblemSpan',
  form: 'HealthFormProblemForm',
} as const;

// Parvane (spec 038, 041; доски `ZpHealthX`, `ZdHealthX`): окно правки записи и дневного сна. Поля зависят
// от вида: значение (у давления — два), отрезок сна «с — до» по дню пробуждения, длительность либо только
// время отметки; у еды — название, приём и БЖУ, у тренировки — тип, расстояние и упражнения. Годится ли запись, решает движок (`healthCheck`) — теми же диапазонами, что у ввода строкой
const HealthEntrySheet = ({
  target, today, goalMinutes, isWide, onNap, onClose,
}: OwnProps) => {
  const {
    lang, kindTitle, unitTitle, duration, shortDuration, entryWhen,
  } = useHealthLabels(today);
  const shown = useCurrentOrPrev(target);
  const entry = shown?.entry;
  const kind = entry?.kind || 'sleep';
  const isSleep = kind === 'sleep';
  // Дневной сон: новый из «Другое», «не в сумму» либо короткий отрезок (меньше четырёх часов)
  const isNap = Boolean(shown?.napDay) || entry?.tag === SLEEP_ASIDE_TAG
    || Boolean(entry && entry.kind === 'sleep' && entry.endMs > entry.atMs && entry.endMs - entry.atMs < NAP_MAX_MS);
  const [isNoSleep, setIsNoSleep] = useState(false);
  const isSpan = isSleep && !isNoSleep && (!entry || entry.endMs > entry.atMs || entry.tag === NO_SLEEP_TAG);
  const isDuration = isSleep && !isSpan && !isNoSleep;
  const isNight = isSleep && !isNap;
  const isMark = kind === 'sleep_start' || kind === 'sleep_end';
  const hasSecondValue = kind === 'pressure';
  const isFood = kind === FOOD_KIND;
  const isWorkout = kind === WORKOUT_KIND;

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [problem, setProblem] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  // Пояс записи; у нового сна — пояс устройства на момент открытия окна
  const [tzMin, setTzMin] = useState(0);

  // Поля окна ставятся в кадре его появления: обычный эффект шёл кадром позже и затирал уже набранное (день
  // дневного сна возвращался к сегодняшнему, и запись в будущем отклонялась)
  useLayoutEffect(() => {
    if (!target) return;
    setProblem(undefined);
    setIsSaving(false);
    const { entry: opened, napDay } = target;
    setTzMin(opened ? opened.tzMin : -new Date().getTimezoneOffset());
    setIsNoSleep(opened?.tag === NO_SLEEP_TAG);
    if (opened?.tag === NO_SLEEP_TAG) {
      setForm({
        ...EMPTY_FORM, day: opened.day, time: NIGHT_FROM, endTime: NIGHT_TO, note: opened.note,
      });
      return;
    }
    if (!opened) {
      setForm({
        ...EMPTY_FORM, day: napDay || today, time: NAP_FROM, endTime: NAP_TO,
      });
      return;
    }
    const start = toLocalParts(opened.atMs, opened.tzMin);
    const end = opened.endMs ? toLocalParts(opened.endMs, opened.tzMin) : undefined;
    setForm({
      ...extraFormOf(opened),
      value: opened.kind === 'sleep' ? formatClock(opened.value) : String(opened.value),
      value2: String(opened.value2),
      day: (end || start).day,
      time: start.time,
      endTime: end ? end.time : '',
      note: opened.note,
    });
  }, [target, today]);

  const handleField = useLastCallback((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.currentTarget;
    setForm((current) => ({ ...current, [name]: value }));
    setProblem(undefined);
  });

  const span = isSpan ? buildSleepSpan(form.day, form.time, form.endTime, tzMin) : undefined;

  function buildDraft(): HealthDraft | undefined {
    const base = {
      kind,
      tzMin,
      endMs: 0,
      value: 0,
      value2: 0,
      unit: entry ? entry.unit : 'min',
      source: entry?.source || 'manual',
      note: form.note.trim(),
    };
    if (isNoSleep) {
      const atMs = fromLocalParts(form.day, '00:00', tzMin);
      return atMs === undefined ? undefined : {
        ...base, atMs, tag: NO_SLEEP_TAG,
      };
    }
    if (isSpan) {
      return span && {
        ...base, atMs: span.atMs, endMs: span.endMs, value: span.minutes, tag: form.tag,
      };
    }
    // Сон одной длительностью хранит момент начала дня: меняется только день
    const atMs = fromLocalParts(form.day, isDuration ? toLocalParts(entry!.atMs, tzMin).time : form.time, tzMin);
    if (atMs === undefined) return undefined;
    if (isMark) return { ...base, atMs };
    const value = isDuration ? parseClock(form.value) : parseNumber(form.value);
    const value2 = hasSecondValue ? parseNumber(form.value2) : 0;
    const extra = extraDraftOf(kind, form, entry?.parts);
    if (value === undefined || value2 === undefined || !extra) return undefined;
    return {
      ...base, ...extra, atMs, value, value2,
    };
  }

  const handleNoSleep = useLastCallback((isOn: boolean) => {
    setIsNoSleep(isOn);
    setProblem(undefined);
    setForm((current) => ({
      ...current, tag: '', time: current.time || NIGHT_FROM, endTime: current.endTime || NIGHT_TO,
    }));
  });

  const handleNap = useLastCallback(() => {
    onNap(form.day);
  });

  const handleCountInSum = useLastCallback((isOn: boolean) => {
    const tag = isOn ? '' : SLEEP_ASIDE_TAG;
    setForm((current) => ({ ...current, tag }));
  });

  const handleSave = useLastCallback(async () => {
    if (isSaving) return;
    const draft = buildDraft();
    if (!draft) {
      setProblem(isSpan || isMark ? 'form' : 'value');
      return;
    }
    setIsSaving(true);
    const found = await checkHealthEntry(draft);
    if (found) {
      setProblem(found);
      setIsSaving(false);
      return;
    }
    if (entry && !shown?.isNew) {
      await saveHealthEntry(entry.id, draft);
    } else if (!await addHealthEntries([draft])) {
      setProblem('form');
      setIsSaving(false);
      return;
    }
    onClose();
  });

  const handleDelete = useLastCallback(() => {
    void deleteHealthEntry(entry!.id);
    onClose();
  });

  const unit = entry && unitTitle(entry.unit);
  const ownLabel = isFood ? lang('HealthFoodKcal') : isWorkout ? lang('HealthWorkoutMinutes') : undefined;
  const valueLabel = ownLabel || (unit ? `${kindTitle(kind)}, ${unit}` : kindTitle(kind));
  const tags: readonly string[] = isFood ? MEALS : WORKOUT_TAGS;

  function renderTag() {
    return (
      <label className={styles.field}>
        <span className={buildClassName(kit.muted, kit.small)}>
          {lang(isFood ? 'HealthFoodMeal' : 'HealthWorkoutType')}
        </span>
        <select className={kit.input} name="tag" value={form.tag} data-health-field="tag" onChange={handleField}>
          {!tags.includes(form.tag) && <option value={form.tag}>{form.tag}</option>}
          {tags.map((tag) => (
            <option key={tag} value={tag}>{lang(isFood ? mealTitleKey(tag) : workoutTitleKey(tag))}</option>
          ))}
        </select>
      </label>
    );
  }

  function renderField(name: keyof Form, label: string, type: string, extra?: { max?: string; inputMode?: 'decimal' }) {
    return (
      <label className={styles.field}>
        <span className={buildClassName(kit.muted, kit.small)}>{label}</span>
        <input
          className={kit.input}
          type={type}
          name={name}
          value={form[name]}
          max={extra?.max}
          inputMode={extra?.inputMode}
          maxLength={name === 'note' ? NOTE_MAX : name === 'name' ? NAME_MAX : undefined}
          data-health-field={name}
          autoComplete="off"
          onChange={handleField}
        />
      </label>
    );
  }

  function renderLine(name: keyof Form, label: string, type: string) {
    return (
      <label className={styles.fieldLine}>
        <span className={kit.grow}>{label}</span>
        <input
          className={styles.fieldLineInput}
          type={type}
          name={name}
          value={form[name]}
          max={type === 'date' ? today : undefined}
          placeholder={name === 'note' ? lang('HealthNoteNone') : undefined}
          maxLength={name === 'note' ? NOTE_MAX : undefined}
          data-health-field={name}
          autoComplete="off"
          onChange={handleField}
        />
      </label>
    );
  }

  function renderTitle() {
    if (!isSleep) {
      return TITLE_KEYS[kind] ? lang(TITLE_KEYS[kind] as 'HealthEntryTitleWeight')
        : lang('HealthEntryEditTitle', { name: kindTitle(kind) });
    }
    if (isNap) return lang('HealthNapTitle');
    const wake = new Date(`${form.day || today}T12:00:00`);
    const nightOn = lang('HealthNightOn');
    const weekday = lang(NIGHT_KEYS[(wake.getDay() + 6) % 7]);
    const date = formatDate(lang.code, wake, DATE_LONG);
    return `${nightOn.charAt(0).toUpperCase()}${nightOn.slice(1)} ${weekday}, ${date}`;
  }

  function renderSpanResult() {
    if (!span) return undefined;
    const delta = isNight && goalMinutes !== undefined ? span.minutes - goalMinutes : undefined;
    if (isNap) {
      return (
        <div className={styles.fieldLine} data-health-span>
          <span className={kit.grow}>{lang('HealthSleepDuration')}</span>
          <span className={kit.mono}>{duration(span.minutes)}</span>
        </div>
      );
    }
    return (
      <div className={styles.spanResult} data-health-span>
        <span className={buildClassName(kit.mono, styles.metricValue)}>{duration(span.minutes)}</span>
        {delta !== undefined && Boolean(delta) && (
          <span className={buildClassName(kit.muted, kit.small)}>
            {lang(delta > 0 ? 'HealthSleepAboveGoal' : 'HealthSleepBelowGoal', {
              duration: shortDuration(delta),
            })}
          </span>
        )}
      </div>
    );
  }

  const subtitle = isSleep ? (
    <input
      className={styles.sheetDate}
      type="date"
      name="day"
      value={form.day}
      max={today}
      aria-label={lang(isSpan ? 'HealthSleepWakeDay' : 'HealthFieldDate')}
      data-health-field="day"
      onChange={handleField}
    />
  ) : entry && <span>{entryWhen(entry)}</span>;

  const saveButton = (
    <button
      type="button"
      className={buildClassName(kit.btn, kit.btnAcc, !isWide && kit.btnWide)}
      disabled={isSaving}
      data-health-save
      onClick={handleSave}
    >
      {lang(entry ? 'Save' : 'HealthNapAdd')}
    </button>
  );
  const deleteButton = entry && !shown?.isNew && (
    <button
      type="button"
      className={buildClassName(kit.btn, kit.btnDanger, styles.btnOutline, !isWide && kit.btnWide)}
      onClick={handleDelete}
    >
      {lang('HealthEntryDelete')}
    </button>
  );
  const cancelButton = (
    <button type="button" className={buildClassName(kit.btn, !isWide && kit.btnWide)} onClick={onClose}>
      {lang('Cancel')}
    </button>
  );

  return (
    <PvSheet
      isOpen={Boolean(target)}
      title={renderTitle()}
      onClose={onClose}
      onEnter={handleSave}
    >
      <div className={styles.sheetSubtitle}>{subtitle}</div>
      <div className={styles.fields} data-health-sheet={kind}>
        {isFood && renderField('name', lang('HealthFoodName'), 'text')}
        {hasExtraFields(kind) && renderTag()}
        {!isSleep && !isMark && (
          <div className={styles.fieldRow}>
            {renderField('value', hasSecondValue ? lang('HealthPressureUpper') : valueLabel, 'text', {
              inputMode: 'decimal',
            })}
            {hasSecondValue && renderField('value2', lang('HealthPressureLower'), 'text', { inputMode: 'decimal' })}
          </div>
        )}
        {isFood && (
          <div className={styles.fieldRow}>
            {renderField('protein', lang('HealthFieldGrams', { name: lang('HealthMacroProtein') }), 'text', DECIMAL)}
            {renderField('fat', lang('HealthFieldGrams', { name: lang('HealthMacroFat') }), 'text', DECIMAL)}
            {renderField('carbs', lang('HealthFieldGrams', { name: lang('HealthMacroCarbs') }), 'text', DECIMAL)}
          </div>
        )}
        {isWorkout && (
          <div className={styles.fieldRow}>
            {renderField('km', lang('HealthWorkoutKm'), 'text', DECIMAL)}
            {renderField('exercises', lang('HealthWorkoutExercisesField'), 'text', DECIMAL)}
          </div>
        )}
        {isDuration && renderField('value', lang('HealthSleepDuration'), 'time')}
        {isSpan && (
          <div className={styles.fieldRow}>
            {renderField('time', lang(isNap ? 'HealthSleepFrom' : 'HealthSleepBedField'), 'time')}
            {renderField('endTime', lang(isNap ? 'HealthSleepTo' : 'HealthSleepWakeField'), 'time')}
          </div>
        )}
        {renderSpanResult()}
        {!isSleep && renderLine('day', lang('HealthFieldDate'), 'date')}
        {!isSleep && renderLine('time', lang('HealthFieldTime'), 'time')}
        {isNight && (
          <div className={styles.fieldLine}>
            <span className={kit.grow}>{lang('HealthNapTitle')}</span>
            <button type="button" className={kit.chip} data-health-action="night-nap" onClick={handleNap}>
              {lang('HealthMealAdd')}
            </button>
          </div>
        )}
        {isNight && (
          <PvSwitch isOn={isNoSleep} className={styles.switchRow} data-health-field="noSleep" onChange={handleNoSleep}>
            <span className={styles.switchText}>{lang('HealthSleepNoSleep')}</span>
          </PvSwitch>
        )}
        {isNap && isSpan && (
          <PvSwitch
            isOn={form.tag !== SLEEP_ASIDE_TAG}
            className={styles.switchRow}
            data-health-field="countInSum"
            onChange={handleCountInSum}
          >
            <span className={styles.switchText}>{lang('HealthSleepCountInSum')}</span>
          </PvSwitch>
        )}
        {renderLine('note', lang('HealthFieldNote'), 'text')}
        {problem && (
          <div className={kit.fieldError} role="alert" data-health-problem={problem}>
            {lang(PROBLEM_KEYS[problem as keyof typeof PROBLEM_KEYS] || PROBLEM_KEYS.form)}
          </div>
        )}
      </div>
      {isWide ? (
        <div className={kit.sheetButtons}>
          {deleteButton}
          <span className={kit.grow} />
          {cancelButton}
          {saveButton}
        </div>
      ) : (
        <div className={buildClassName(kit.sheetButtons, styles.sheetColumn)}>
          {saveButton}
          {deleteButton || cancelButton}
        </div>
      )}
      {!entry && <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthNapLineHint')}</div>}
    </PvSheet>
  );
};

export default memo(HealthEntrySheet);
