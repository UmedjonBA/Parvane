import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type {
  PlannerRepeat, PlannerSeriesItem, PlannerState, PlannerStatus, PlannerTask,
} from './plannerModel';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';
import type { PlannerDescriptionScope as DescriptionScope } from './plannerSeriesEdit';
import type { PlannerPromptScope } from './PlannerSeriesPrompt';

import buildClassName from '../../../util/buildClassName';
import {
  formatClock, formatDay, formatStatus,
} from './plannerFormat';
import {
  detachInstance, excludeInstance, findSlots, MIN_TASK_MINUTES, MINUTES_IN_DAY, PLANNER_STATUSES,
  removeSeries, setTaskDone, setTaskStepDone, splitSeries, toMinutes, truncateSeries, updateSeries, validateRepeat,
} from './plannerModel';
import {
  changedFields, getDescriptionScope, patchCopies, seriesOfCopy, setDescription, shareDescription, updateFromCopy,
} from './plannerSeriesEdit';
import { changeSeriesRule, nearestSeriesDay, sameRepeat } from './plannerSeriesRule';
import { showPlannerNotice, updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Select from '../../ui/Select';
import TextArea from '../../ui/TextArea';
import { PlannerCardRow, PlannerRepeatRow } from './PlannerCardRow';
import PlannerDescriptionScope from './PlannerDescriptionScope';
import PlannerField from './PlannerField';
import PlannerListPicker from './PlannerListPicker';
import PlannerName from './PlannerName';
import PlannerRemindSelect from './PlannerRemindSelect';
import { draftToRepeat, repeatToDraft } from './PlannerRepeatFields';
import PlannerSeriesPrompt from './PlannerSeriesPrompt';
import { REPEAT_ERROR_KEYS } from './PlannerTaskForm';

import styles from './Planner.module.scss';

const SAVED_SHOWN_MS = 2000;

type OwnProps = {
  state: PlannerState;
  // Задача, шаблон ряда либо экземпляр ряда (`instanceDay`, spec 011)
  task: PlannerTask;
  today: string;
  picked: string;
  onBack: NoneToVoidFunction;
  onPickDay: (day: string) => void;
  onOpenTask: (taskId: string, day?: string) => void;
};

type Slot = { day: string; start: string; end: string };
// `rule` — новое правило повтора у экземпляра; без правила — «Не повторяется»
// `copy` — правка отделённого дня ряда: только он либо весь ряд с остальными отделёнными днями
type Pending = { kind: 'patch' | 'copy'; changes: Partial<PlannerTask>; notice: string }
  | { kind: 'delete' }
  | { kind: 'rule'; repeat?: PlannerRepeat };

const STEP_MAX_LENGTH = 160;
const NAME_MAX_LENGTH = 160;

const PlannerTaskEditor = ({
  state, task, today, picked, onBack, onPickDay, onOpenTask,
}: OwnProps) => {
  const lang = useLang();

  // «Сохранено» на пару секунд после правки описания
  const [isSaved, setIsSaved] = useState(false);
  const savedTimerRef = useRef<number>();
  const markSaved = () => {
    setIsSaved(true);
    window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setIsSaved(false), SAVED_SHOWN_MS);
  };

  // Название правится в поле и записывается по Enter или уходу из поля; пустое — возвращается прежнее
  const [isNameEditing, setIsNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(task.name);
  useEffect(() => {
    setIsNameEditing(false);
  }, [task.id]);

  const [stepText, setStepText] = useState('');
  const [slots, setSlots] = useState<Slot[]>();
  const [slotHint, setSlotHint] = useState<string>();
  const [pending, setPending] = useState<Pending>();
  const [repeatDraft, setRepeatDraft] = useState<PlannerRepeatDraft>(
    () => repeatToDraft(task.repeat, task.day || today),
  );
  const [repeatError, setRepeatError] = useState<string>();
  // Чьё описание: всех повторов либо только этого дня; `undefined` — запись не из ряда, галочки нет
  const [descriptionScope, setDescriptionScope] = useState<DescriptionScope | undefined>(
    () => getDescriptionScope(state, 'task', task),
  );
  // У экземпляра ряда описание сохраняется кнопкой: до неё можно выбрать, чьё оно
  const [descriptionDraft, setDescriptionDraft] = useState(task.description);

  const isInstance = Boolean(task.repeat && task.instanceDay);

  const patchTemplate = useLastCallback((changes: Partial<PlannerTask>, notice: string) => {
    updatePlanner((draft) => {
      const target = draft.tasks.find(({ id }) => id === task.id);
      if (target) Object.assign(target, changes);
    }, notice);
    setSlots(undefined);
  });

  // У экземпляра ряда правка полей требует выбора объёма (FR-004); у отделённого дня — тоже, если изменённое
  // можно отдать ряду (свой день и отметка выполнения остаются у дня)
  const patch = useLastCallback((changes: Partial<PlannerTask>, notice: string) => {
    if (isInstance) {
      setPending({ kind: 'patch', changes, notice });
      return true;
    }
    if (seriesOfCopy(state, 'task', task) && Object.keys(changedFields(task, changes)).length) {
      setPending({ kind: 'copy', changes, notice });
      return true;
    }
    patchTemplate(changes, notice);
    return true;
  });

  const handleScope = useLastCallback((scope: PlannerPromptScope) => {
    const action = pending!;
    const instanceDay = task.instanceDay!;
    setPending(undefined);
    if (action.kind === 'copy') {
      if (scope === 'one') {
        patchTemplate(action.changes, action.notice);
        return;
      }
      updatePlanner((draft) => {
        const target = draft.tasks.find(({ id }) => id === task.id);
        if (target) Object.assign(target, action.changes);
        updateFromCopy(draft, 'task', task, changedFields(task, action.changes));
      }, action.notice);
      setSlots(undefined);
      return;
    }
    if (action.kind === 'rule') {
      const { repeat } = action;
      let result: PlannerSeriesItem | undefined;
      updatePlanner((draft) => {
        result = repeat
          ? changeSeriesRule(draft, 'task', task.id, instanceDay, repeat, scope === 'following' ? 'following' : 'all')
          : changeSeriesRule(draft, 'task', task.id, instanceDay, undefined, scope === 'stop' ? 'stop' : 'one');
      }, lang(repeat ? 'PlannerNoticeRepeatUpdated' : 'PlannerNoticeRepeatStopped', { name: task.name }));
      // Карточка остаётся на записи этого дня: разовой копии, продолжении ряда либо ближайшем дне нового правила
      if (result) onOpenTask(result.id, nearestSeriesDay(result, instanceDay));
      return;
    }
    if (action.kind === 'delete') {
      updatePlanner((draft) => {
        if (scope === 'one') excludeInstance(draft, 'task', task.id, instanceDay);
        else if (scope === 'following') truncateSeries(draft, 'task', task.id, instanceDay);
        else removeSeries(draft, 'task', task.id);
      }, lang('PlannerNoticeTaskDeleted', { name: task.name }));
      onBack();
      return;
    }
    let detachedId: string | undefined;
    let seriesId = task.id;
    updatePlanner((draft) => {
      if (scope === 'one') {
        detachedId = detachInstance(draft, 'task', task.id, instanceDay, action.changes)?.id;
        return;
      }
      // Новый день экземпляра переносит ряд (весь либо его продолжение), а не пишется в шаблон
      if (scope === 'following') {
        const fields = { ...action.changes, day: undefined };
        seriesId = splitSeries(draft, 'task', task.id, instanceDay, fields)?.id || seriesId;
      }
      updateSeries(draft, 'task', seriesId, instanceDay, action.changes);
      // Уже отделённые дни ряда (всего либо с этого дня) получают те же изменённые поля
      patchCopies(
        draft, 'task', task.id, changedFields(task, action.changes), scope === 'following' ? instanceDay : undefined,
      );
    }, action.notice);
    if (detachedId) onOpenTask(detachedId);
    else if (seriesId !== task.id || action.changes.day) onOpenTask(seriesId, action.changes.day || instanceDay);
  });

  const handleCancelPrompt = useLastCallback(() => {
    setPending(undefined);
  });

  const handleDay = useLastCallback((value: string) => {
    patch(value ? { day: value } : { day: undefined, start: undefined }, value
      ? lang('PlannerNoticeMoved', { date: formatDay(lang, value), name: task.name })
      : lang('PlannerNoticeUnscheduled', { name: task.name }));
  });

  const handleDue = useLastCallback((value: string) => {
    patch({ due: value || undefined }, lang('PlannerNoticeDueUpdated', { name: task.name }));
  });

  const handleRemind = useLastCallback((value: number | undefined) => {
    patch({ remind: value }, lang('PlannerNoticeRemindUpdated', { name: task.name }));
  });

  const handleStart = useLastCallback((value: string) => {
    if (value && !task.day && !task.repeat) {
      showPlannerNotice(lang('PlannerErrorNeedDay'));
      return false;
    }
    if (value && task.minutes !== undefined && toMinutes(value) + task.minutes > MINUTES_IN_DAY) {
      showPlannerNotice(lang('PlannerErrorPastMidnight'));
      return false;
    }
    return patch({ start: value || undefined }, lang('PlannerNoticeTimeUpdated', { name: task.name }));
  });

  const handleMinutes = useLastCallback((value: string) => {
    const minutes = value === '' ? undefined : Number(value);
    if (minutes !== undefined
      && (!Number.isFinite(minutes) || minutes < MIN_TASK_MINUTES || minutes > MINUTES_IN_DAY)) {
      showPlannerNotice(lang('PlannerErrorMinutes'));
      return false;
    }
    if (task.start && minutes && toMinutes(task.start) + minutes > MINUTES_IN_DAY) {
      showPlannerNotice(lang('PlannerErrorPastMidnight'));
      return false;
    }
    return patch(
      { minutes, start: minutes === undefined ? undefined : task.start },
      lang('PlannerNoticeEstimateUpdated', { name: task.name }),
    );
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNameDraft(e.currentTarget.value);
  });

  const handleNameEdit = useLastCallback(() => {
    setNameDraft(task.name);
    setIsNameEditing(true);
  });

  const handleNameTitleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLHeadingElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    handleNameEdit();
  });

  // Значение — из поля: состояние обновится только к следующему кадру, а Enter приходит сразу после ввода
  const handleNameCommit = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsNameEditing(false);
    const name = e.currentTarget.value.trim();
    if (!name || name === task.name) return;
    patch({ name }, lang('PlannerNoticeNameUpdated', { name }));
  });

  const handleNameKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setNameDraft(task.name);
      setIsNameEditing(false);
    }
  });

  const handleDescription = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const description = e.currentTarget.value;
    if (isInstance) {
      setDescriptionDraft(description);
      return;
    }
    // Отделённый день с галочкой «для всех» пишет описание и в свой ряд
    updatePlanner((draft) => {
      setDescription(draft, 'task', task, description, descriptionScope || 'one');
    });
    markSaved();
  });

  // «Для всех» — описание ряда (отделённые дни хранят своё); «только этот день» — день отделяется без вопроса
  const handleDescriptionSave = useLastCallback(() => {
    let savedId: string | undefined;
    updatePlanner((draft) => {
      savedId = setDescription(draft, 'task', task, descriptionDraft, descriptionScope || 'all')?.id;
    }, lang('PlannerNoticeDescriptionUpdated', { name: task.name }));
    if (savedId && savedId !== task.id) onOpenTask(savedId);
  });

  const handleDescriptionScope = useLastCallback((scope: DescriptionScope) => {
    setDescriptionScope(scope);
    // Отделённый день: «для всех» переносит его описание в ряд (вопрос уже задан)
    if (scope !== 'all' || isInstance) return;
    updatePlanner((draft) => {
      shareDescription(draft, 'task', task);
    }, lang('PlannerNoticeDescriptionUpdated', { name: task.name }));
  });

  // Шаги экземпляра отмечаются по дню, без выбора объёма (FR-005)
  const handleStepToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const index = Number(e.currentTarget.value);
    const isDone = e.currentTarget.checked;
    updatePlanner((draft) => {
      setTaskStepDone(draft, task, index, isDone);
    }, lang('PlannerNoticeStepUpdated', { name: task.steps[index].text }));
  });

  const handleStepSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = stepText.trim();
    if (!text) return;
    const steps = [
      ...task.steps.map((step) => ({ text: step.text, isDone: isInstance ? false : step.isDone })),
      { text, isDone: false },
    ];
    patch({ steps }, lang('PlannerNoticeStepAdded'));
    setStepText('');
  });

  const handleStatus = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    patch({ status: e.currentTarget.value as PlannerStatus }, lang('PlannerNoticeStatusUpdated', { name: task.name }));
  });

  const handleProject = useLastCallback((project: string) => {
    patch({ project }, lang('PlannerNoticeListUpdated', { name: task.name }));
  });

  const handleFindSlots = useLastCallback(() => {
    if (!task.minutes) {
      setSlots(undefined);
      setSlotHint(lang('PlannerErrorNeedMinutes'));
      return;
    }
    const found = findSlots(state, task, today, picked);
    setSlots(found);
    const { settings } = state;
    const window = `${formatClock(settings.dayStart)}–${formatClock(settings.dayEnd)}`;
    setSlotHint(found.length ? window : lang('PlannerSlotsNone'));
  });

  const handleSlotClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const slot = slots![Number(e.currentTarget.dataset.index)];
    onPickDay(slot.day);
    patch(
      { day: slot.day, start: slot.start },
      lang('PlannerNoticeScheduled', { date: formatDay(lang, slot.day), time: slot.start }),
    );
  });

  // Правило повтора: у шаблона ряда и разовой задачи пишется сразу; у экземпляра спрашивается объём —
  // «это и последующие» или «все в серии», а для «Не повторяется» — с какого дня ряда больше нет
  const handleRepeatSave = useLastCallback(() => {
    const repeat = draftToRepeat(repeatDraft);
    const problem = repeat && validateRepeat(repeat);
    if (problem) {
      setRepeatError(lang(REPEAT_ERROR_KEYS[problem]));
      return;
    }
    setRepeatError(undefined);
    if (isInstance) {
      // Сравнение — с правилом в том виде, в каком его показывает форма
      if (!sameRepeat(repeat, draftToRepeat(repeatToDraft(task.repeat)))) setPending({ kind: 'rule', repeat });
      return;
    }
    updatePlanner((draft) => {
      const target = draft.tasks.find(({ id }) => id === task.id);
      if (!target) return;
      target.repeat = repeat;
      if (repeat) {
        target.day = undefined;
        target.due = undefined;
        if (target.status === 'done') target.status = 'queue';
      } else {
        target.occurrences = undefined;
      }
    }, lang('PlannerNoticeRepeatUpdated', { name: task.name }));
  });

  const handleOpenSeries = useLastCallback(() => {
    onOpenTask(task.id);
  });

  const handleDelete = useLastCallback(() => {
    if (isInstance) {
      setPending({ kind: 'delete' });
      return;
    }
    updatePlanner((draft) => {
      draft.tasks = draft.tasks.filter(({ id }) => id !== task.id);
    }, lang('PlannerNoticeTaskDeleted', { name: task.name }));
    onBack();
  });

  const handleDone = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { checked } = e.currentTarget;
    updatePlanner((draft) => {
      setTaskDone(draft, task, checked);
    }, lang(checked ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  // О чём спрашивает выбор объёма: правка полей, удаление, новое правило повтора либо его снятие
  const promptMode = !pending ? undefined
    : pending.kind === 'rule' ? (pending.repeat ? 'rule' : 'stop')
      : pending.kind === 'delete' ? 'delete' : pending.kind === 'copy' ? 'copy' : 'edit';

  const isDone = task.status === 'done';

  const doneSteps = task.steps.filter((step) => step.isDone).length;
  return (
    <div className={buildClassName(styles.editor, styles.eventCard)}>
      {isNameEditing ? (
        <input
          id="planner-task-name"
          className={styles.cardTitleInput}
          value={nameDraft}
          maxLength={NAME_MAX_LENGTH}
          autoFocus
          aria-label={lang('PlannerFieldTaskName')}
          placeholder={lang('PlannerFieldTaskName')}
          onChange={handleNameChange}
          onBlur={handleNameCommit}
          onKeyDown={handleNameKeyDown}
        />
      ) : (
        // Нажатие на название (кроме ссылок на заметки) открывает его правку
        <h2
          className={buildClassName(styles.editorTitle, styles.editorTitleEditable)}
          tabIndex={0}
          title={lang('PlannerRenameHint')}
          data-task-name
          onClick={handleNameEdit}
          onKeyDown={handleNameTitleKeyDown}
        >
          <PlannerName name={task.name} />
          <Icon name="edit" className={styles.editorTitleIcon} />
        </h2>
      )}
      {/* Поля задачи пишутся сразу (у события — кнопка «Сохранить»): об этом нужно сказать */}
      <p className={styles.small} data-task-autosave>
        {isSaved ? lang('PlannerSaved') : lang('PlannerAutoSaved')}
      </p>
      {task.origin && <p className={styles.small}>{lang('PlannerSeriesDetachedHint')}</p>}
      {(!task.repeat || isInstance) && (
        <label className={buildClassName(styles.row, styles.rowButton, isDone && styles.rowDone)}>
          <input type="checkbox" className={styles.check} checked={isDone} onChange={handleDone} />
          <span>{lang(isDone ? 'PlannerStatusDone' : 'PlannerMarkDone')}</span>
        </label>
      )}

      <PlannerCardRow icon="clock" row="when">
        <div className={buildClassName(styles.fields, (!task.repeat || isInstance) && styles.fieldsThree)}>
          {(!task.repeat || isInstance) && (
            <PlannerField label={lang('PlannerFieldWorkDate')} type="date" value={task.day} onCommit={handleDay} />
          )}
          <PlannerField label={lang('PlannerFieldStart')} type="time" value={task.start} onCommit={handleStart} />
          <PlannerField
            label={lang('PlannerFieldMinutes')}
            type="number"
            value={task.minutes === undefined ? '' : String(task.minutes)}
            min={MIN_TASK_MINUTES}
            max={MINUTES_IN_DAY}
            step={5}
            placeholder={lang('PlannerNoEstimate')}
            onCommit={handleMinutes}
          />
        </div>
        {!task.repeat && (
          <div className={styles.fields}>
            <PlannerField label={lang('PlannerFieldDue')} type="date" value={task.due} onCommit={handleDue} />
          </div>
        )}
      </PlannerCardRow>

      <PlannerRepeatRow value={repeatDraft} onChange={setRepeatDraft}>
        {repeatError && <p className={styles.error} role="alert">{repeatError}</p>}
        <button type="button" className={styles.btn} data-repeat-save onClick={handleRepeatSave}>
          <Icon name="loop" />
          {lang('PlannerRepeatSave')}
        </button>
      </PlannerRepeatRow>
      {isInstance && (
        <button type="button" className={styles.linkButton} onClick={handleOpenSeries}>
          {lang('PlannerSeriesOpen')}
        </button>
      )}

      <PlannerCardRow icon="folder" row="group">
        <PlannerListPicker id="planner-task-list" state={state} value={task.project} onChange={handleProject} />
      </PlannerCardRow>

      <PlannerCardRow icon="schedule" row="status">
        <div className={styles.fields}>
          <Select
            id="planner-task-status"
            label={lang('PlannerFieldStatus')}
            value={task.status}
            hasArrow
            onChange={handleStatus}
          >
            {PLANNER_STATUSES.map((item) => <option key={item} value={item}>{formatStatus(lang, item)}</option>)}
          </Select>
          <PlannerRemindSelect id="planner-task-remind" value={task.remind} onChange={handleRemind} />
        </div>
      </PlannerCardRow>

      <PlannerCardRow icon="info" row="description">
        <TextArea
          label={lang('PlannerFieldDescription')}
          value={isInstance ? descriptionDraft : task.description}
          onChange={handleDescription}
        />
        {descriptionScope && (
          <PlannerDescriptionScope
            scope={descriptionScope}
            shouldConfirmAll={!isInstance}
            onChange={handleDescriptionScope}
          />
        )}
        {isInstance && descriptionDraft !== task.description && (
          <button type="button" className={styles.btn} data-description-save onClick={handleDescriptionSave}>
            {lang('PlannerDescriptionSave')}
          </button>
        )}
      </PlannerCardRow>

      <PlannerCardRow icon="check" row="steps">
        <span className={styles.fieldLabel}>{lang('PlannerSteps', { done: doneSteps, total: task.steps.length })}</span>
        {task.steps.map((step, index) => (
          <label
            key={`${index}${step.text}`}
            className={buildClassName(styles.row, styles.rowButton, styles.rowStep, step.isDone && styles.rowDone)}
          >
            <input
              type="checkbox"
              className={buildClassName(styles.check, styles.checkSmall)}
              value={String(index)}
              checked={step.isDone}
              onChange={handleStepToggle}
            />
            <span className={styles.rowTitle}>{step.text}</span>
          </label>
        ))}
        <form className={styles.stepForm} onSubmit={handleStepSubmit}>
          <PlannerField
            label={lang('PlannerStepNew')}
            type="text"
            value={stepText}
            maxLength={STEP_MAX_LENGTH}
            onInput={setStepText}
          />
          <button type="submit" className={styles.ib} aria-label={lang('PlannerStepAdd')}>
            <Icon name="add" />
          </button>
        </form>
      </PlannerCardRow>

      <PlannerCardRow icon="search" row="slots">
        <button type="button" className={styles.btn} onClick={handleFindSlots}>{lang('PlannerFindSlots')}</button>
        <div className={styles.slots} aria-live="polite">
          {slotHint && <span className={styles.small}>{slotHint}</span>}
          {slots?.map((slot, index) => (
            <button
              key={`${slot.day}${slot.start}`}
              type="button"
              className={styles.slot}
              data-index={index}
              onClick={handleSlotClick}
            >
              {`${formatDay(lang, slot.day)} · ${slot.start}–${slot.end}`}
            </button>
          ))}
        </div>
      </PlannerCardRow>

      {promptMode ? (
        <PlannerSeriesPrompt
          mode={promptMode}
          onChoose={handleScope}
          onCancel={handleCancelPrompt}
        />
      ) : (
        <button type="button" className={buildClassName(styles.btn, styles.btnDanger)} onClick={handleDelete}>
          <Icon name="delete" />
          {lang('PlannerDeleteTask')}
        </button>
      )}
    </div>
  );
};

export default memo(PlannerTaskEditor);
