import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerSettings } from './plannerModel';
import type { QuickDraft, QuickField, QuickKind } from './plannerQuick';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatDuration, formatRepeat } from './plannerFormat';
import { ALL_DAY_END, ALL_DAY_START, newId } from './plannerModel';
import { parseQuickInput } from './plannerQuick';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import { EVENT_ERROR_KEYS, TASK_ERROR_KEYS } from './PlannerTaskForm';

import styles from './Planner.module.scss';

type OwnProps = {
  isOpen: boolean;
  today: string;
  settings: PlannerSettings;
  onCreated: (day?: string) => void;
  onMore: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

type KindChoice = 'auto' | 'task' | 'event';
type Chip = { field: QuickField; text: string; isFixed?: boolean };

const KIND_CHOICES: KindChoice[] = ['auto', 'event', 'task'];
const KIND_LABELS = {
  auto: 'PlannerQuickAuto',
  event: 'PlannerKindEvent',
  task: 'PlannerKindTask',
} as const;
// Питание и вода разбираются, но записывать их начнёт раздел «Здоровье» (spec 017 FR-006)
const QUICK_KINDS: QuickKind[] = ['task', 'event'];
const NAME_MAX_LENGTH = 160;
const INPUT_MAX_LENGTH = 300;
const FOCUS_DELAY_MS = 200;

// Ввод текстом (spec 017): строка → черновик записи, распознанное видно чипами под полем
const PlannerQuickInput = ({
  isOpen, today, settings, onCreated, onMore, onClose,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<KindChoice>('auto');
  const [skip, setSkip] = useState<QuickField[]>([]);

  const lang = useLang();

  useEffect(() => {
    if (!isOpen) return undefined;
    setText('');
    setChoice('auto');
    setSkip([]);
    // Поле появляется вместе с окном: фокус — после его показа
    const timeout = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isOpen]);

  const draft = useMemo(() => {
    const now = new Date();
    return parseQuickInput(text, {
      today,
      nowMinutes: now.getHours() * 60 + now.getMinutes(),
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      kind: choice === 'auto' ? undefined : choice,
      kinds: QUICK_KINDS,
      skip,
    });
  }, [text, today, settings, choice, skip]);

  const chips = useMemo(() => buildChips(lang, draft), [lang, draft]);
  const hasText = Boolean(text.trim());
  const isNameTooLong = draft.name.length > NAME_MAX_LENGTH;
  const errorKey = !hasText ? undefined
    : draft.kind === 'event' ? EVENT_ERROR_KEYS[draft.error as keyof typeof EVENT_ERROR_KEYS]
      : TASK_ERROR_KEYS[draft.error as keyof typeof TASK_ERROR_KEYS];
  const canSubmit = hasText && !draft.error && !isNameTooLong;

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
    // Правка строки возвращает снятые значения: слова могли измениться
    if (skip.length) setSkip([]);
  });

  const handleSubmit = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    const { repeat } = draft;
    const day = repeat ? undefined : draft.day;
    updatePlanner((state) => {
      if (draft.kind === 'event') {
        state.events.push({
          id: newId(),
          name: draft.name,
          start: draft.isAllDay ? ALL_DAY_START : draft.start!,
          end: draft.isAllDay ? ALL_DAY_END : draft.end!,
          day,
          repeat,
          isAllDay: draft.isAllDay,
        });
        return;
      }
      state.tasks.push({
        id: newId(),
        name: draft.name,
        description: '',
        steps: [],
        status: 'queue',
        project: '',
        minutes: draft.minutes,
        day,
        start: draft.start,
        due: draft.due,
        repeat,
        // Новая задача — первой в очереди
        rank: Math.min(0, ...state.tasks.map(({ rank }) => rank)) - 1,
      });
    }, lang('PlannerNoticeAdded', { name: draft.name }));
    onCreated(draft.day);
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

  const handleChoice = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setChoice(e.currentTarget.dataset.kind as KindChoice);
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
          className={buildClassName('form-control', styles.quickInput)}
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
        <div className={styles.quickKinds} role="radiogroup">
          {KIND_CHOICES.map((kind) => {
            const isActive = choice === kind || (choice === 'auto' && hasText && draft.kind === kind);
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={choice === kind}
                data-kind={kind}
                className={buildClassName(styles.quickKind, isActive && styles.quickKindOn)}
                onClick={handleChoice}
              >
                {lang(KIND_LABELS[kind])}
              </button>
            );
          })}
          <button type="button" className={styles.quickMore} onClick={onMore}>{lang('PlannerQuickMore')}</button>
        </div>
        {hasText ? (
          <div className={styles.quickDraft} aria-live="polite">
            <div className={styles.quickName} dir="auto">{draft.name || lang('PlannerQuickNoName')}</div>
            <div className={styles.quickChips}>
              {chips.map(({ field, text: label, isFixed }) => (
                <span key={field} className={styles.quickChip} data-quick-chip={field}>
                  {label}
                  {!isFixed && (
                    <button
                      type="button"
                      className={styles.quickChipRemove}
                      data-field={field}
                      aria-label={lang('PlannerQuickRemove', { value: label })}
                      onClick={handleSkip}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {errorKey && <div className={styles.quickError} role="alert">{lang(errorKey)}</div>}
            {isNameTooLong && <div className={styles.quickError} role="alert">{lang('PlannerQuickTooLong')}</div>}
          </div>
        ) : (
          <div className={styles.quickHint}>{lang('PlannerQuickHint')}</div>
        )}
        <Button size="smaller" disabled={!canSubmit} onClick={handleSubmit}>{lang('PlannerAdd')}</Button>
      </form>
    </Modal>
  );
};

function buildChips(lang: ReturnType<typeof useLang>, draft: QuickDraft): Chip[] {
  const has = (field: QuickField) => draft.spans.some((span) => span.field === field);
  const chips: Chip[] = [];
  if (draft.repeat) {
    chips.push({ field: 'repeat', text: formatRepeat(lang, draft.repeat) });
  } else if (draft.day) {
    chips.push({ field: 'day', text: formatDay(lang, draft.day), isFixed: draft.isDayAssumed });
  }
  if (draft.isAllDay) chips.push({ field: 'time', text: lang('PlannerAllDayShort'), isFixed: true });
  else if (draft.start) {
    chips.push({ field: 'time', text: draft.end ? `${draft.start}–${draft.end}` : draft.start });
  }
  if (draft.minutes && (draft.kind === 'task' || !draft.end)) {
    chips.push({ field: 'minutes', text: formatDuration(lang, draft.minutes), isFixed: !has('minutes') });
  }
  if (draft.due) chips.push({ field: 'due', text: lang('PlannerQuickDue', { date: formatDay(lang, draft.due) }) });
  return chips;
}

export default memo(PlannerQuickInput);
