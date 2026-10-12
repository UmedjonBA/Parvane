import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { IconName } from '../../../types/icons';
import type { PlannerSettings } from './plannerModel';
import type { QuickDraft, QuickField, QuickKind } from './plannerQuick';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDayLabel, formatDuration, formatRepeat, formatSpan,
} from './plannerFormat';
import { applyQuickDraft, formatPace } from './plannerHealth';
import { toTime } from './plannerModel';
import { getQuickLang, parseQuickInput } from './plannerQuick';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Modal from '../../ui/Modal';
import { EVENT_ERROR_KEYS, TASK_ERROR_KEYS } from './PlannerTaskForm';

import styles from './Planner.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Строка, с которой окно открывается (пример с экрана «Здоровье»)
  initialText?: string;
  today: string;
  settings: PlannerSettings;
  onCreated: (day?: string) => void;
  onMore: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

type KindChoice = 'auto' | 'task' | 'event' | 'food' | 'sleep' | 'workout';
type Chip = { field: QuickField; text: string; isFixed?: boolean; key?: string };

const KIND_CHOICES: KindChoice[] = ['auto', 'event', 'task', 'food', 'sleep', 'workout'];
const KIND_LABELS = {
  auto: 'PlannerQuickAuto',
  event: 'PlannerKindEvent',
  task: 'PlannerKindTask',
  food: 'PlannerKindFood',
  sleep: 'PlannerKindSleep',
  workout: 'PlannerKindWorkout',
} as const;
const DRAFT_KIND_LABELS = {
  event: 'PlannerKindEvent',
  task: 'PlannerKindTask',
  food: 'PlannerKindFood',
  water: 'PlannerHealthWater',
  sleep: 'PlannerKindSleep',
  workout: 'PlannerKindWorkout',
  metric: 'PlannerHealthBody',
  goal: 'PlannerHealthGoals',
} as const satisfies Record<QuickKind, string>;
const KIND_CLASSES = {
  event: styles.kindEvent,
  task: styles.kindTask,
  food: styles.kindFood,
  water: styles.kindFood,
  sleep: styles.kindSleep,
  workout: styles.kindWorkout,
  metric: styles.kindMetric,
  goal: styles.kindMuted,
} satisfies Record<QuickKind, string>;
const KIND_ICONS = {
  event: 'calendar',
  task: 'check',
  food: 'eats',
  water: 'eats',
  sleep: 'darkmode',
  workout: 'sport',
  metric: 'heart-outline',
  goal: 'settings',
} as const satisfies Record<QuickKind, IconName>;
// Виды, которые в переключателе стоят под одной кнопкой
const CHOICE_OF: Partial<Record<QuickKind, KindChoice>> = { water: 'food', metric: 'auto', goal: 'auto' };
const METRIC_LABELS = {
  weight: 'PlannerHealthWeight',
  pressure: 'PlannerHealthPressure',
  pulse: 'PlannerHealthPulse',
  steps: 'PlannerHealthStepsShort',
  mood: 'PlannerHealthMood',
} as const;
const MEAL_LABELS = {
  breakfast: 'PlannerMealBreakfast',
  lunch: 'PlannerMealLunch',
  dinner: 'PlannerMealDinner',
  snack: 'PlannerMealSnack',
  other: 'PlannerMealOther',
} as const;
const NAME_MAX_LENGTH = 160;
const INPUT_MAX_LENGTH = 300;
const FOCUS_DELAY_MS = 200;

// Ввод текстом (spec 017): строка → черновик записи, распознанное видно чипами под полем
const PlannerQuickInput = ({
  isOpen, initialText, today, settings, onCreated, onMore, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<KindChoice>('auto');
  const [skip, setSkip] = useState<QuickField[]>([]);

  const lang = useLang();

  useEffect(() => {
    if (!isOpen) return undefined;
    setText(initialText || '');
    setChoice('auto');
    setSkip([]);
    // Поле появляется вместе с окном: фокус — после его показа
    const timeout = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isOpen, initialText]);

  const parse = useLastCallback((value: string) => {
    const now = new Date();
    return parseQuickInput(value, {
      today,
      nowMinutes: now.getHours() * 60 + now.getMinutes(),
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      kind: choice === 'auto' ? undefined : choice,
      skip,
      lang: getQuickLang(lang.code),
    });
  });

  // Разбор дешёвый (доли миллисекунды) — считается на каждой перерисовке
  const draft = parse(text);
  const chips = useMemo(() => buildChips(lang, draft), [lang, draft]);
  const hasText = Boolean(text.trim());
  const isNameTooLong = draft.name.length > NAME_MAX_LENGTH;
  const errorKey = !hasText || !draft.error ? undefined
    : EVENT_ERROR_KEYS[draft.error as keyof typeof EVENT_ERROR_KEYS]
      || TASK_ERROR_KEYS[draft.error as keyof typeof TASK_ERROR_KEYS];
  const canSubmit = hasText && !draft.error && !isNameTooLong;

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
    // Правка строки возвращает снятые значения: слова могли измениться
    if (skip.length) setSkip([]);
  });

  const handleSubmit = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    // Enter может прийти раньше перерисовки: черновик берётся из самого поля, а не из показанного
    const value = inputRef.current?.value ?? text;
    const entry = parse(value);
    if (!value.trim() || entry.error || entry.name.length > NAME_MAX_LENGTH) return;
    updatePlanner((state) => {
      applyQuickDraft(state, entry, today);
    }, entry.kind === 'goal' ? lang('PlannerNoticeGoalsSaved')
      : lang('PlannerNoticeAdded', { name: entry.name || value.trim() }));
    onCreated(entry.day);
  });

  // Окно перехватывает Enter раньше формы — добавляем по клавише в самом поле
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleSubmit();
  });

  const handleSkip = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSkip([...skip, e.currentTarget.dataset.field as QuickField]);
    inputRef.current?.focus();
  });

  const handleSubmitClick = useLastCallback(() => handleSubmit());

  // Примеры — на языке интерфейса: их разбирает словарь того же языка
  const examples = useMemo(() => lang('PlannerQuickExamples').split(/\s*\|\s*/).filter(Boolean), [lang]);

  const handleChoice = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setChoice(e.currentTarget.dataset.kind as KindChoice);
    inputRef.current?.focus();
  });

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setText(e.currentTarget.dataset.text!);
    setSkip([]);
    inputRef.current?.focus();
  });

  return (
    <Modal
      isOpen={isOpen}
      title={lang('PlannerQuickTitle')}
      className={styles.quick}
      hasCloseButton
      onClose={onClose}
    >
      <form className={styles.quickForm} data-quick-kind={draft.kind} onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          id="planner-quick-input"
          className={styles.quickInput}
          type="text"
          value={text}
          maxLength={INPUT_MAX_LENGTH}
          placeholder={lang('PlannerQuickPlaceholder')}
          aria-label={lang('PlannerQuickTitle')}
          autoComplete="off"
          enterKeyHint="done"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <div className={styles.quickPreview} aria-live="polite">
          {hasText ? (
            <>
              <span className={buildClassName(styles.tag, styles.tagLarge, KIND_CLASSES[draft.kind])}>
                <Icon name={KIND_ICONS[draft.kind]} />
                {draft.metric ? lang(METRIC_LABELS[draft.metric]) : lang(DRAFT_KIND_LABELS[draft.kind])}
              </span>
              {chips.map(({
                field, text: label, isFixed, key,
              }) => (
                <span
                  key={key || field}
                  className={buildClassName(styles.tag, styles.tagLarge, styles.kindMuted)}
                  data-quick-chip={field}
                >
                  {label}
                  {!isFixed && (
                    <button
                      type="button"
                      className={styles.tagRemove}
                      data-field={field}
                      aria-label={lang('PlannerQuickRemove', { value: label })}
                      onClick={handleSkip}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </span>
              ))}
              {draft.kind === 'task' || draft.kind === 'event' ? (
                <div className={styles.quickParts}>
                  <div className={styles.quickPart} data-quick-part="name">
                    <span className={styles.quickPartLabel}>{lang('PlannerQuickName')}</span>
                    <span className={buildClassName(styles.quickPartText, styles.quickPartName)} dir="auto">
                      {draft.name || lang('PlannerQuickNoName')}
                    </span>
                  </div>
                  {draft.description && (
                    <div className={styles.quickPart} data-quick-part="description" data-quick-chip="description">
                      <span className={styles.quickPartLabel}>{lang('PlannerFieldDescription')}</span>
                      <span className={styles.quickPartText} dir="auto">{draft.description}</span>
                      <button
                        type="button"
                        className={styles.tagRemove}
                        data-field="description"
                        aria-label={lang('PlannerQuickRemove', { value: lang('PlannerFieldDescription') })}
                        title={lang('PlannerQuickDescriptionToName')}
                        onClick={handleSkip}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className={styles.quickName} dir="auto">
                  {draft.name || (draft.metric && lang(METRIC_LABELS[draft.metric]))
                    || (draft.kind === 'sleep' && lang('PlannerKindSleep'))
                    || (draft.kind === 'water' && lang('PlannerHealthWater'))
                    || (draft.kind === 'goal' && lang('PlannerHealthGoals')) || lang('PlannerQuickNoName')}
                </div>
              )}
              {errorKey && <div className={styles.quickError} role="alert">{lang(errorKey)}</div>}
              {isNameTooLong && <div className={styles.quickError} role="alert">{lang('PlannerQuickTooLong')}</div>}
            </>
          ) : (
            <span className={styles.muted}>{lang('PlannerQuickHint')}</span>
          )}
        </div>
        <div className={buildClassName(styles.hscroll, 'no-scrollbar')} role="radiogroup">
          {KIND_CHOICES.map((kind) => {
            const isActive = choice === kind
              || (choice === 'auto' && hasText && (CHOICE_OF[draft.kind] || draft.kind) === kind);
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={choice === kind}
                data-kind={kind}
                className={buildClassName(
                  styles.chip, kind !== 'auto' && KIND_CLASSES[kind], isActive && styles.chipOn,
                )}
                onClick={handleChoice}
              >
                {lang(KIND_LABELS[kind])}
              </button>
            );
          })}
        </div>
        <div>
          <div className={styles.sheetHint}>{lang('PlannerQuickExamplesTitle')}</div>
          <div className={styles.chips}>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className={styles.chip}
                data-text={example}
                data-quick-example
                onClick={handleExample}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.quickFooter}>
          <span className={buildClassName(styles.muted, styles.grow)}>
            {lang('PlannerQuickDefault', { date: formatDayLabel(lang, today) })}
          </span>
          <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onMore}>
            {lang('PlannerQuickMore')}
          </button>
          <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={onClose}>
            {lang('Cancel')}
          </button>
          <button
            type="button"
            className={buildClassName(styles.btn, styles.btnAccent)}
            disabled={!canSubmit}
            onClick={handleSubmitClick}
          >
            {lang('PlannerAdd')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

function buildChips(lang: ReturnType<typeof useLang>, draft: QuickDraft): Chip[] {
  const has = (field: QuickField) => draft.spans.some((span) => span.field === field);
  const chips: Chip[] = [];
  const fixed = (field: QuickField, text: string) => chips.push({ field, text, isFixed: true });
  const number = (value: number) => lang.number(value);
  if (draft.kind === 'goal') {
    const changes = draft.goalChanges!;
    Object.entries(changes.goals).forEach(([metric, value]) => fixed('health', `${metric} → ${number(value)}`));
    Object.entries(changes.health).forEach(([key, value]) => fixed('health', `${key} → ${number(value)}`));
    if (changes.dayStart !== undefined) {
      fixed('time', `${toTime(changes.dayStart)}–${toTime(changes.dayEnd!)}`);
    }
    if (changes.budget) fixed('minutes', formatDuration(lang, changes.budget));
    return chips.map((chip, index) => ({ ...chip, key: `${chip.field}${index}` }));
  }
  if (draft.kind === 'metric') {
    if (draft.value !== undefined) {
      fixed('health', draft.value2 ? `${draft.value}/${draft.value2}` : number(draft.value));
    }
    return chips;
  }
  if (draft.kind === 'water') {
    if (draft.waterMl) fixed('water', lang('PlannerHealthMl', { value: draft.waterMl }));
    return chips;
  }
  if (draft.kind === 'sleep') {
    if (draft.start && draft.end) fixed('time', `${draft.start}–${draft.end}`);
    if (draft.minutes) fixed('minutes', formatSpan(draft.minutes));
    return chips;
  }
  if (draft.repeat) {
    chips.push({ field: 'repeat', text: formatRepeat(lang, draft.repeat) });
  } else if (draft.day) {
    chips.push({ field: 'day', text: formatDay(lang, draft.day), isFixed: draft.isDayAssumed || !has('day') });
  }
  if (draft.kind === 'food') {
    const nutrients = draft.nutrients || {};
    if (draft.meal) fixed('meal', lang(MEAL_LABELS[draft.meal]));
    if (nutrients.kcal !== undefined) fixed('kcal', lang('PlannerHealthKcal', { value: number(nutrients.kcal) }));
    if (nutrients.protein !== undefined || nutrients.fat !== undefined || nutrients.carbs !== undefined) {
      fixed('protein', lang('PlannerHealthMacros', {
        protein: number(nutrients.protein || 0), fat: number(nutrients.fat || 0), carbs: number(nutrients.carbs || 0),
      }));
    }
    if (nutrients.fiber !== undefined) {
      fixed('fiber', lang('PlannerHealthFiberShort', { value: number(nutrients.fiber) }));
    }
    if (draft.grams) fixed('grams', lang('PlannerHealthGramsNoGoal', { value: number(draft.grams) }));
    return chips;
  }
  if (draft.kind === 'workout') {
    if (draft.start) fixed('time', draft.start);
    if (draft.minutes) fixed('minutes', formatDuration(lang, draft.minutes));
    if (draft.distanceKm) {
      const pace = formatPace(draft.minutes || 0, draft.distanceKm);
      fixed('health', [
        lang('PlannerHealthKm', { value: number(draft.distanceKm) }),
        pace && lang('PlannerHealthPace', { value: pace }),
      ].filter(Boolean).join(' · '));
    }
    if (draft.exercises) fixed('grams', lang('PlannerQuickWorkoutSets', { count: draft.exercises.length }));
    return chips;
  }
  if (draft.isAllDay) chips.push({ field: 'time', text: lang('PlannerAllDayShort'), isFixed: true });
  else if (draft.start) {
    chips.push({ field: 'time', text: draft.end ? `${draft.start}–${draft.end}` : draft.start });
  }
  if (draft.minutes && (draft.kind === 'task' || !draft.end)) {
    chips.push({ field: 'minutes', text: formatDuration(lang, draft.minutes), isFixed: !has('minutes') });
  }
  if (draft.due) chips.push({ field: 'due', text: lang('PlannerQuickDue', { date: formatDay(lang, draft.due) }) });
  if (draft.list) chips.push({ field: 'list', text: `#${draft.list}` });
  if (draft.place) chips.push({ field: 'place', text: `@${draft.place}` });
  if (draft.isImportant) chips.push({ field: 'important', text: `! ${lang('PlannerStatusActive')}` });
  return chips;
}

export default memo(PlannerQuickInput);
