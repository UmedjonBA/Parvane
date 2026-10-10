import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type {
  PlannerEventError, PlannerRepeatError, PlannerSlot, PlannerState, PlannerStatus, PlannerTaskError,
} from './plannerModel';
import type { PlannerRepeatDraft } from './PlannerRepeatFields';

import { formatStatus } from './plannerFormat';
import {
  ALL_DAY_END, ALL_DAY_START, ensureList, getDefaultEventEnd, newId, PLANNER_STATUSES, toTime,
  validateEvent, validateRepeat, validateTask,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import Select from '../../ui/Select';
import TextArea from '../../ui/TextArea';
import PlannerField from './PlannerField';
import PlannerListPicker from './PlannerListPicker';
import PlannerRepeatFields, { draftToRepeat, emptyRepeatDraft } from './PlannerRepeatFields';

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

const TASK_ERROR_KEYS = {
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

const EVENT_ERROR_KEYS = {
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

  const handleKindChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.currentTarget.value as 'task' | 'event';
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
    if (kind === 'event') {
      const event = {
        name: name.trim(),
        start: isAllDay ? ALL_DAY_START : start,
        end: isAllDay ? ALL_DAY_END : (end || (start ? getDefaultEventEnd(start) : '')),
        repeat,
        day: repeat ? undefined : (day || undefined),
        isAllDay: isAllDay || undefined,
        isHoliday: isHoliday || undefined,
      };
      const eventError = validateEvent(event);
      if (eventError) {
        setError(lang(EVENT_ERROR_KEYS[eventError]));
        return;
      }
      updatePlanner((draft) => {
        draft.events.push({ ...event, id: newId() });
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
    updatePlanner((draft) => {
      ensureList(draft, project);
      draft.tasks.push({
        ...task,
        id: taskId,
        description: description.trim(),
        steps: [],
        status,
        project,
        repeat,
        // Новая задача — первой в очереди
        rank: Math.min(0, ...draft.tasks.map(({ rank }) => rank)) - 1,
      });
    }, lang('PlannerNoticeAdded', { name: task.name }));
    onCreated(taskId, repeat?.startDay || undefined);
  });

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <Select
        id="planner-new-kind"
        label={lang('PlannerFieldKind')}
        value={kind}
        hasArrow
        onChange={handleKindChange}
      >
        <option value="task">{lang('PlannerKindTask')}</option>
        <option value="event">{lang('PlannerKindEvent')}</option>
      </Select>
      <InputText
        id="planner-new-name"
        label={lang(kind === 'task' ? 'PlannerFieldTaskName' : 'PlannerFieldEventName')}
        value={name}
        maxLength={NAME_MAX_LENGTH}
        autoFocus
        onChange={handleNameChange}
      />
      {kind === 'task' ? (
        <>
          <TextArea
            label={lang('PlannerFieldDescription')}
            value={description}
            onChange={handleDescriptionChange}
            noReplaceNewlines
          />
          <div className={styles.fields}>
            {repeatDraft.kind === 'none' && (
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
            {repeatDraft.kind === 'none' && (
              <PlannerField label={lang('PlannerFieldDue')} type="date" value={due} onInput={setDue} />
            )}
          </div>
          <PlannerRepeatFields value={repeatDraft} onChange={setRepeatDraft} />
          <div className={styles.fields}>
            <Select
              id="planner-new-status"
              label={lang('PlannerFieldStatus')}
              value={status}
              hasArrow
              onChange={handleStatusChange}
            >
              {PLANNER_STATUSES.map((item) => <option key={item} value={item}>{formatStatus(lang, item)}</option>)}
            </Select>
          </div>
          <PlannerListPicker id="planner-new-list" state={state} value={project} onChange={setProject} />
        </>
      ) : (
        <>
          <div className={styles.checks}>
            <Checkbox label={lang('PlannerAllDay')} checked={isAllDay} onCheck={setIsAllDay} />
            <Checkbox label={lang('PlannerHoliday')} checked={isHoliday} onCheck={setIsHoliday} />
          </div>
          {!isAllDay && (
            <div className={styles.fields}>
              <PlannerField label={lang('PlannerFieldStart')} type="time" value={start} onInput={handleStart} />
              <PlannerField label={lang('PlannerFieldEnd')} type="time" value={end} onInput={handleEnd} />
            </div>
          )}
          {repeatDraft.kind === 'none' && (
            <PlannerField label={lang('PlannerFieldEventDate')} type="date" value={day} onInput={setDay} />
          )}
          <PlannerRepeatFields value={repeatDraft} onChange={setRepeatDraft} />
        </>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <Button type="submit" size="smaller">{lang('PlannerCreate')}</Button>
        <Button isText size="smaller" onClick={onCancel}>{lang('Cancel')}</Button>
      </div>
    </form>
  );
};

export default memo(PlannerTaskForm);
