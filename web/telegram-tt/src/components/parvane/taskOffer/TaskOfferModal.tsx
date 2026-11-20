import { memo, useLayoutEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import { getChatTitle } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import {
  DEFAULT_PLANNER_SETTINGS, MINUTES_IN_DAY, toDayKey, toTime, validateTask,
} from '../planner/plannerModel';
import { getQuickLang, parseQuickInput } from '../planner/plannerQuick';
import { formatOfferWhen } from './taskOfferFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ChatScreen from '../chatScreen/ChatScreen';
import PvIcon from '../notes/PvIcon';

import screen from '../chatScreen/ChatScreen.module.scss';
import kit from '../notes/PvKit.module.scss';
import styles from './TaskOfferModal.module.scss';

// Поля, заполненные заранее: «Предложить собеседнику…» из меню записи «Плана»
export type TaskOfferDraft = {
  name: string;
  description?: string;
  steps?: string[];
  day?: string;
  start?: string;
  minutes?: number;
  due?: string;
};

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  initial?: TaskOfferDraft;
  onClose: NoneToVoidFunction;
};

type Fields = {
  name: string;
  description: string;
  steps: string[];
  day: string;
  start: string;
  minutes: string;
  due: string;
};

const NAME_MAX_LENGTH = 200;
const MAX_STEPS = 100;
const STEP_MAX_LENGTH = 160;
const MINUTES_IN_HOUR = 60;

const EMPTY_FIELDS: Fields = {
  name: '', description: '', steps: [], day: '', start: '', minutes: '', due: '',
};

const TASK_ERROR_KEYS = {
  name: 'PlannerErrorName',
  minutes: 'PlannerErrorMinutes',
  startNeedsDayAndMinutes: 'PlannerErrorStartNeeds',
  pastMidnight: 'PlannerErrorPastMidnight',
  dayAfterDue: 'PlannerErrorDayAfterDue',
} as const;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 011, US3; доска `XpChat`): «Предложить в план» экраном — строка «Одной строкой» разбирается
// разбором «Плана» и заполняет строки «Что сделать / День и начало / Длительность / Срок»; шаги — списком
const TaskOfferModal = ({
  isOpen, chatId, initial, onClose,
}: OwnProps) => {
  const lang = useLang();

  const [quick, setQuick] = useState('');
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [newStep, setNewStep] = useState('');
  const [error, setError] = useState<string>();
  const [isSending, setIsSending] = useState(false);

  // Начальные значения ставятся до первого кадра экрана: ввод в кадр появления не теряется
  useLayoutEffect(() => {
    if (!isOpen) return;
    setQuick('');
    setNewStep('');
    setError(undefined);
    setFields(initial ? {
      name: initial.name,
      description: initial.description || '',
      steps: initial.steps || [],
      day: initial.day || '',
      start: initial.start || '',
      minutes: initial.minutes === undefined ? '' : String(initial.minutes),
      due: initial.due || '',
    } : EMPTY_FIELDS);
  }, [isOpen, initial]);

  const recipient = useMemo(() => {
    if (!isOpen) return undefined;
    const chat = getGlobal().chats.byId[chatId];
    return chat ? getChatTitle(lang, chat) : undefined;
  }, [isOpen, chatId, lang]);

  const handleQuickChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    setQuick(value);
    if (!value.trim()) return;
    const now = new Date();
    const draft = parseQuickInput(value, {
      today: toDayKey(now),
      nowMinutes: now.getHours() * MINUTES_IN_HOUR + now.getMinutes(),
      dayStart: DEFAULT_PLANNER_SETTINGS.dayStart,
      dayEnd: DEFAULT_PLANNER_SETTINGS.dayEnd,
      kind: 'task',
      lang: getQuickLang(lang.code),
    });
    setFields((prev) => ({
      ...prev,
      name: draft.name.slice(0, NAME_MAX_LENGTH),
      description: draft.description || prev.description,
      day: draft.day || '',
      start: draft.start || '',
      minutes: draft.minutes ? String(draft.minutes) : '',
      due: draft.due || '',
    }));
  });

  const handleFieldChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { value, dataset } = e.currentTarget;
    const key = dataset.field as Exclude<keyof Fields, 'steps'>;
    setFields((prev) => ({ ...prev, [key]: value }));
  });

  const handleNewStepChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewStep(e.currentTarget.value);
  });

  // Значение берётся из поля: Enter сразу после ввода приходит раньше отрисовки с новым состоянием
  const addStep = useLastCallback((value = newStep) => {
    const text = value.trim().slice(0, STEP_MAX_LENGTH);
    if (!text) return;
    setFields((prev) => ({ ...prev, steps: [...prev.steps, text].slice(0, MAX_STEPS) }));
    setNewStep('');
  });

  const handleAddStepClick = useLastCallback(() => addStep());

  const handleNewStepKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    addStep(e.currentTarget.value);
  });

  const handleRemoveStep = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const index = Number(e.currentTarget.dataset.index);
    setFields((prev) => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }));
  });

  const handleSubmit = useLastCallback(async () => {
    if (isSending) return;
    const task = {
      name: fields.name.trim(),
      minutes: fields.minutes === '' ? undefined : Number(fields.minutes),
      day: fields.day || undefined,
      start: fields.start || undefined,
      due: fields.due || undefined,
    };
    const problem = validateTask(task);
    if (problem) {
      setError(lang(TASK_ERROR_KEYS[problem]));
      return;
    }
    const chat = getGlobal().chats.byId[chatId];
    if (!chat) return;
    // Шаг, набранный и не добавленный, тоже уходит
    const steps = [...fields.steps, newStep.trim()]
      .map((step) => step.slice(0, STEP_MAX_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_STEPS);
    setIsSending(true);
    try {
      await callParvane('parvaneSendTaskOffer', {
        chat,
        offer: { ...task, description: fields.description.trim(), steps },
      });
      onClose();
    } catch {
      setError(lang('TaskOfferSendFailed'));
    } finally {
      setIsSending(false);
    }
  });

  const minutes = Number(fields.minutes) || undefined;
  const understood = quick.trim() && fields.name ? [
    lang('PlannerKindTask'),
    fields.name,
    formatOfferWhen(lang, {
      day: fields.day || undefined,
      start: fields.start && minutes ? `${fields.start}–${addMinutes(fields.start, minutes)}` : fields.start,
      minutes: fields.start ? undefined : minutes,
      due: fields.due || undefined,
    }),
  ].filter(Boolean).join(' · ') : undefined;

  return (
    <ChatScreen
      isOpen={isOpen}
      title={lang('TaskOfferTitle')}
      subtitle={recipient ? lang('TaskOfferFor', { name: recipient }) : undefined}
      actionLabel={lang('TaskOfferSend')}
      isActionDisabled={isSending}
      onAction={handleSubmit}
      onClose={onClose}
    >
      <div className={screen.pad} data-task-offer-screen>
        <label className={screen.fld}>
          {lang('TaskOfferQuick')}
          <input
            className={screen.inp}
            type="text"
            value={quick}
            placeholder={lang('TaskOfferQuickPlaceholder')}
            data-task-offer-quick
            onChange={handleQuickChange}
          />
        </label>
        {understood && (
          <div className={screen.note} data-task-offer-understood>
            <span className={styles.muted}>{lang('TaskOfferUnderstood')}</span>
            {' '}
            {understood}
          </div>
        )}
      </div>
      <div className={screen.grp}>
        <label className={screen.sr}>
          <span className={screen.srMain}>{lang('TaskOfferWhat')}</span>
          <input
            id="task-offer-name"
            className={buildClassName(styles.cellInput, styles.cellName)}
            type="text"
            aria-label={lang('PlannerFieldTaskName')}
            value={fields.name}
            maxLength={NAME_MAX_LENGTH}
            data-field="name"
            onChange={handleFieldChange}
          />
        </label>
        <div className={screen.sr}>
          <span className={screen.srMain}>{lang('TaskOfferDayAndStart')}</span>
          <input
            className={buildClassName(styles.cellInput, styles.cellDate, screen.mono)}
            type="date"
            aria-label={lang('PlannerFieldWorkDate')}
            value={fields.day}
            data-field="day"
            onChange={handleFieldChange}
          />
          <input
            className={buildClassName(styles.cellInput, styles.cellTime, screen.mono)}
            type="time"
            aria-label={lang('PlannerFieldStart')}
            value={fields.start}
            data-field="start"
            onChange={handleFieldChange}
          />
        </div>
        <label className={screen.sr}>
          <span className={screen.srMain}>{lang('TaskOfferDuration')}</span>
          <input
            className={buildClassName(styles.cellInput, styles.cellNumber, screen.mono)}
            type="number"
            min={5}
            max={1440}
            step={5}
            aria-label={lang('PlannerFieldMinutes')}
            placeholder={lang('PlannerNoEstimate')}
            value={fields.minutes}
            data-field="minutes"
            onChange={handleFieldChange}
          />
        </label>
        <label className={screen.sr}>
          <span className={screen.srMain}>{lang('PlannerFieldDue')}</span>
          <input
            className={buildClassName(styles.cellInput, styles.cellDate, screen.mono)}
            type="date"
            aria-label={lang('PlannerFieldDue')}
            value={fields.due}
            data-field="due"
            onChange={handleFieldChange}
          />
        </label>
      </div>
      <div className={screen.cap}>{lang('TaskOfferStepsTitle')}</div>
      <div className={screen.grp} data-task-offer-steps>
        {fields.steps.map((step, index) => (
          <div className={screen.sr} key={`${index}-${step}`} data-task-offer-step>
            <span className={screen.srMain} dir="auto">{step}</span>
            <button
              type="button"
              className={kit.ib}
              aria-label={lang('TaskOfferRemoveStep')}
              data-index={index}
              onClick={handleRemoveStep}
            >
              <PvIcon name="x" isSmall />
            </button>
          </div>
        ))}
        <div className={screen.sr}>
          <input
            className={buildClassName(styles.cellInput, styles.cellStep)}
            type="text"
            aria-label={lang('TaskOfferNewStep')}
            placeholder={lang('TaskOfferNewStep')}
            value={newStep}
            maxLength={STEP_MAX_LENGTH}
            onChange={handleNewStepChange}
            onKeyDown={handleNewStepKeyDown}
          />
          <button
            type="button"
            className={buildClassName(styles.addStep, screen.srAccent)}
            disabled={!newStep.trim()}
            onClick={handleAddStepClick}
          >
            {lang('TaskOfferAddStep')}
          </button>
        </div>
      </div>
      <div className={screen.cap}>{lang('PlannerFieldDescription')}</div>
      <div className={screen.pad}>
        <textarea
          className={styles.description}
          aria-label={lang('PlannerFieldDescription')}
          rows={2}
          value={fields.description}
          data-field="description"
          onChange={handleFieldChange}
        />
      </div>
      {error && <p className={buildClassName(screen.error, styles.errorLine)} role="alert">{error}</p>}
      <div className={screen.hint}>{lang('TaskOfferHint')}</div>
    </ChatScreen>
  );
};

function addMinutes(start: string, minutes: number) {
  const [hours, mins] = start.split(':').map(Number);
  return toTime(Math.min(hours * MINUTES_IN_HOUR + mins + minutes, MINUTES_IN_DAY - 1));
}

export default memo(TaskOfferModal);
