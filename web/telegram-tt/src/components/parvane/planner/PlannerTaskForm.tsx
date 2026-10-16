import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type {
  PlannerEventError, PlannerRepeatError, PlannerSlot, PlannerState, PlannerStatus, PlannerTaskError,
} from './plannerModel';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';
import type { PlannerDescriptionScope as DescriptionScope } from './plannerSeriesEdit';

import buildClassName from '../../../util/buildClassName';
import { formatStatus } from './plannerFormat';
import {
  ALL_DAY_END, ALL_DAY_START, ensureList, getDefaultEventEnd, newId, PLANNER_STATUSES, toDayKey, toTime,
  validateEvent, validateRepeat, validateTask,
} from './plannerModel';
import { addEntry } from './plannerSeriesEdit';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import Select from '../../ui/Select';
import TextArea from '../../ui/TextArea';
import { PlannerCardRow, PlannerRepeatRow } from './PlannerCardRow';
import PlannerDescriptionScope from './PlannerDescriptionScope';
import PlannerField from './PlannerField';
import PlannerListPicker, { PlannerColorSwatches } from './PlannerListPicker';
import PlannerRemindSelect from './PlannerRemindSelect';
import { draftToRepeat, emptyRepeatDraft } from './PlannerRepeatFields';

import styles from './Planner.module.scss';

export type PlannerFormParams = {
  day?: string;
  status?: PlannerStatus;
  project?: string;
  // Свободное окно дня, из которого открыта форма: задача должна в него поместиться
  slot?: PlannerSlot & { day: string };
};

type OwnProps = {
  state: PlannerState;
  params: PlannerFormParams;
  onCreated: (taskId?: string, day?: string) => void;
  onCancel: NoneToVoidFunction;
};

export const TASK_ERROR_KEYS = {
  name: 'PlannerErrorName',
  minutes: 'PlannerErrorMinutes',
  startNeedsDayAndMinutes: 'PlannerErrorStartNeeds',
  pastMidnight: 'PlannerErrorPastMidnight',
  dayAfterDue: 'PlannerErrorDayAfterDue',
} as const satisfies Record<PlannerTaskError, string>;

export const REPEAT_ERROR_KEYS = {
  interval: 'PlannerErrorRepeatInterval',
  weekdays: 'PlannerErrorRepeatWeekdays',
  monthDay: 'PlannerErrorRepeatMonthDay',
  startDay: 'PlannerErrorRepeatStart',
  endDay: 'PlannerErrorRepeatEnd',
  count: 'PlannerErrorRepeatCount',
} as const satisfies Record<PlannerRepeatError, string>;

export const EVENT_ERROR_KEYS = {
  name: 'PlannerErrorName',
  time: 'PlannerErrorEventTime',
  repeat: 'PlannerErrorEventRepeat',
  ...REPEAT_ERROR_KEYS,
} as const satisfies Record<PlannerEventError, string>;

const DEFAULT_SLOT_MINUTES = 30;
const NAME_MAX_LENGTH = 160;

// Новая задача либо событие — разовое или ряд по правилу повтора (spec 011)
const PlannerTaskForm = ({
  state, params, onCreated, onCancel,
}: OwnProps) => {
  const lang = useLang();

  const { slot } = params;
  const [kind, setKind] = useState<'task' | 'event'>('task');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Описание ряда — всех повторов (по умолчанию) либо только первого дня
  const [descriptionScope, setDescriptionScope] = useState<DescriptionScope>('all');
  const [minutes, setMinutes] = useState(
    () => (slot ? String(Math.min(DEFAULT_SLOT_MINUTES, slot.end - slot.start)) : ''),
  );
  const [day, setDay] = useState(params.day || '');
  const [start, setStart] = useState(() => (slot ? toTime(slot.start) : ''));
  const [end, setEnd] = useState(() => (slot ? toTime(Math.min(slot.end, slot.start + 60)) : ''));
  const [due, setDue] = useState('');
  const [status, setStatus] = useState<PlannerStatus>(params.status || 'queue');
  const [project, setProject] = useState(params.project || '');
  const [repeatDraft, setRepeatDraft] = useState<PlannerRepeatDraft>(() => emptyRepeatDraft(params.day || ''));
  const [isAllDay, setIsAllDay] = useState(false);
  const [isHoliday, setIsHoliday] = useState(false);
  const [eventColor, setEventColor] = useState(0);
  const [remind, setRemind] = useState<number>();
  // Конец события следует за началом (+1 ч), пока пользователь не задал его сам
  const [isEndTouched, setIsEndTouched] = useState(Boolean(slot));
  const [error, setError] = useState<string>();

  // Выбор дня в календаре при открытой форме меняет дату формы
  useEffect(() => {
    if (params.day) setDay(params.day);
  }, [params.day]);

  const handleStart = useLastCallback((value: string) => {
    setStart(value);
    if (kind === 'event' && !isEndTouched && value) setEnd(getDefaultEventEnd(value));
  });

  const handleEnd = useLastCallback((value: string) => {
    setEnd(value);
    setIsEndTouched(true);
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handleDescriptionChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.currentTarget.value);
  });

  const handleKindChange = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const next = e.currentTarget.dataset.newKind as 'task' | 'event';
    setKind(next);
    if (next === 'event' && start && !isEndTouched) setEnd(getDefaultEventEnd(start));
    setError(undefined);
  });

  const handleStatusChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus(e.currentTarget.value as PlannerStatus);
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const repeat = draftToRepeat(repeatDraft);
    // День отсчёта первого повтора у ряда без даты начала
    const fallbackDay = day || toDayKey(new Date());
    if (kind === 'event') {
      const event = {
        name: name.trim(),
        description: description.trim() || undefined,
        start: isAllDay ? ALL_DAY_START : start,
        end: isAllDay ? ALL_DAY_END : (end || (start ? getDefaultEventEnd(start) : '')),
        repeat,
        day: repeat ? undefined : (day || undefined),
        isAllDay: isAllDay || undefined,
        isHoliday: isHoliday || undefined,
        // Цвет — у группы; свой цвет события — только без группы
        color: project ? undefined : eventColor || undefined,
        project: project || undefined,
        remind,
      };
      const eventError = validateEvent(event);
      if (eventError) {
        setError(lang(EVENT_ERROR_KEYS[eventError]));
        return;
      }
      updatePlanner((draft) => {
        ensureList(draft, project);
        addEntry(draft, 'event', { ...event, id: newId() }, descriptionScope, fallbackDay);
      }, lang('PlannerNoticeAdded', { name: event.name }));
      onCreated();
      return;
    }

    // Задача-ряд: дата работы — у правила (`startDay`), у шаблона её нет
    const task = {
      name: name.trim(),
      minutes: minutes === '' ? undefined : Number(minutes),
      day: repeat ? undefined : (day || undefined),
      start: start || undefined,
      due: repeat ? undefined : (due || undefined),
      remind,
    };
    const taskError = validateTask(repeat && start ? { ...task, day: repeat.startDay || day } : task);
    if (taskError) {
      setError(lang(TASK_ERROR_KEYS[taskError]));
      return;
    }
    const repeatError = repeat && validateRepeat(repeat);
    if (repeatError) {
      setError(lang(REPEAT_ERROR_KEYS[repeatError]));
      return;
    }
    const taskId = newId();
    // Первый день с собственным описанием — отдельная запись: карточка открывается на ней
    let ownDayId: string | undefined;
    updatePlanner((draft) => {
      ensureList(draft, project);
      ownDayId = addEntry(draft, 'task', {
        ...task,
        id: taskId,
        description: description.trim(),
        steps: [],
        status,
        project,
        repeat,
        // Новая задача — первой в очереди
        rank: Math.min(0, ...draft.tasks.map(({ rank }) => rank)) - 1,
      }, descriptionScope, fallbackDay)?.id;
    }, lang('PlannerNoticeAdded', { name: task.name }));
    if (ownDayId) onCreated(ownDayId);
    else onCreated(taskId, repeat?.startDay || undefined);
  });

  const hasDate = repeatDraft.kind === 'none';

  return (
    <form className={buildClassName(styles.form, styles.eventCard)} onSubmit={handleSubmit}>
      <div className={styles.kindSwitch} role="radiogroup" aria-label={lang('PlannerFieldKind')}>
        {(['task', 'event'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={kind === item}
            className={buildClassName(styles.kindSwitchButton, kind === item && styles.kindSwitchActive)}
            data-new-kind={item}
            onClick={handleKindChange}
          >
            {lang(item === 'task' ? 'PlannerKindTask' : 'PlannerKindEvent')}
          </button>
        ))}
      </div>
      <input
        id="planner-new-name"
        className={styles.cardTitleInput}
        value={name}
        maxLength={NAME_MAX_LENGTH}
        autoFocus
        aria-label={lang(kind === 'task' ? 'PlannerFieldTaskName' : 'PlannerFieldEventName')}
        placeholder={lang(kind === 'task' ? 'PlannerFieldTaskName' : 'PlannerFieldEventName')}
        onChange={handleNameChange}
      />

      {kind === 'task' ? (
        <PlannerCardRow icon="clock" row="when">
          <div className={buildClassName(styles.fields, hasDate && styles.fieldsThree)}>
            {hasDate && (
              <PlannerField label={lang('PlannerFieldWorkDate')} type="date" value={day} onInput={setDay} />
            )}
            <PlannerField label={lang('PlannerFieldStart')} type="time" value={start} onInput={setStart} />
            <PlannerField
              label={lang('PlannerFieldMinutes')}
              type="number"
              value={minutes}
              min={5}
              max={1440}
              step={5}
              placeholder={lang('PlannerNoEstimate')}
              onInput={setMinutes}
            />
          </div>
          {hasDate && (
            <div className={styles.fields}>
              <PlannerField label={lang('PlannerFieldDue')} type="date" value={due} onInput={setDue} />
            </div>
          )}
        </PlannerCardRow>
      ) : (
        <PlannerCardRow icon="clock" row="when">
          <div className={buildClassName(styles.fields, hasDate && !isAllDay && styles.fieldsThree)}>
            {hasDate && (
              <PlannerField label={lang('PlannerFieldEventDate')} type="date" value={day} onInput={setDay} />
            )}
            {!isAllDay && (
              <PlannerField label={lang('PlannerFieldStart')} type="time" value={start} onInput={handleStart} />
            )}
            {!isAllDay && (
              <PlannerField label={lang('PlannerFieldEnd')} type="time" value={end} onInput={handleEnd} />
            )}
          </div>
          <div className={styles.checks}>
            <Checkbox label={lang('PlannerAllDay')} checked={isAllDay} onCheck={setIsAllDay} />
            <Checkbox label={lang('PlannerHoliday')} checked={isHoliday} onCheck={setIsHoliday} />
          </div>
        </PlannerCardRow>
      )}

      <PlannerRepeatRow value={repeatDraft} onChange={setRepeatDraft} />

      <PlannerCardRow icon="folder" row="group">
        <PlannerListPicker id="planner-new-list" state={state} value={project} onChange={setProject} />
        {kind === 'event' && !project && <PlannerColorSwatches value={eventColor} onChange={setEventColor} />}
      </PlannerCardRow>

      <PlannerCardRow icon="schedule" row="remind">
        <div className={buildClassName(kind === 'task' && styles.fields)}>
          {kind === 'task' && (
            <Select
              id="planner-new-status"
              label={lang('PlannerFieldStatus')}
              value={status}
              hasArrow
              onChange={handleStatusChange}
            >
              {PLANNER_STATUSES.map((item) => <option key={item} value={item}>{formatStatus(lang, item)}</option>)}
            </Select>
          )}
          <PlannerRemindSelect id="planner-new-remind" value={remind} onChange={setRemind} />
        </div>
      </PlannerCardRow>

      <PlannerCardRow icon="info" row="description">
        <TextArea
          id="planner-new-description"
          label={lang('PlannerFieldDescription')}
          value={description}
          onChange={handleDescriptionChange}
          noReplaceNewlines
        />
        {repeatDraft.kind !== 'none' && (
          <PlannerDescriptionScope scope={descriptionScope} onChange={setDescriptionScope} />
        )}
      </PlannerCardRow>

      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <Button type="submit" size="smaller">{lang('PlannerCreate')}</Button>
        <Button isText size="smaller" onClick={onCancel}>{lang('Cancel')}</Button>
      </div>
    </form>
  );
};

export default memo(PlannerTaskForm);
