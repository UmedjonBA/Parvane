import { memo, useState } from '../../../lib/teact/teact';

import type {
  PlannerEventError, PlannerSlot, PlannerState, PlannerStatus, PlannerTaskError,
} from './plannerModel';

import {
  formatDay, formatDuration, formatProject, formatStatus, formatWeekday,
} from './plannerFormat';
import {
  fitsBookingWindow, PLANNER_STATUSES, toTime, validateEvent, validateTask,
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
  onCreated: (taskId?: number) => void;
  onCancel: NoneToVoidFunction;
};

const TASK_ERROR_KEYS = {
  name: 'PlannerErrorName',
  minutes: 'PlannerErrorMinutes',
  startNeedsDayAndMinutes: 'PlannerErrorStartNeeds',
  pastMidnight: 'PlannerErrorPastMidnight',
  dayAfterDue: 'PlannerErrorDayAfterDue',
} as const satisfies Record<PlannerTaskError, string>;

const EVENT_ERROR_KEYS = {
  name: 'PlannerErrorName',
  time: 'PlannerErrorEventTime',
  repeat: 'PlannerErrorEventRepeat',
} as const satisfies Record<PlannerEventError, string>;

const DEFAULT_SLOT_MINUTES = 30;
const NAME_MAX_LENGTH = 160;
// Понедельник — первым; значения — как `Date.getDay`
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

// Новая задача либо событие (разовое или повторяющееся по дням недели)
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
  const [isRepeating, setIsRepeating] = useState(false);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [error, setError] = useState<string>();

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.currentTarget.value);
  });

  const handleDescriptionChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.currentTarget.value);
  });

  const handleKindChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setKind(e.currentTarget.value as 'task' | 'event');
    setError(undefined);
  });

  const handleStatusChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatus(e.currentTarget.value as PlannerStatus);
  });

  const handleProjectChange = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setProject(e.currentTarget.value);
  });

  const handleWeekdayToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const weekday = Number(e.currentTarget.value);
    setWeekdays(e.currentTarget.checked ? [...weekdays, weekday] : weekdays.filter((item) => item !== weekday));
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (kind === 'event') {
      const event = {
        name: name.trim(),
        start,
        end,
        weekdays: isRepeating ? weekdays : undefined,
        day: isRepeating ? undefined : (day || undefined),
      };
      const eventError = validateEvent(event);
      if (eventError) {
        setError(lang(EVENT_ERROR_KEYS[eventError]));
        return;
      }
      updatePlanner((draft) => {
        draft.events.push({ ...event, id: draft.nextId++ });
      }, lang('PlannerNoticeAdded', { name: event.name }));
      onCreated();
      return;
    }

    const task = {
      name: name.trim(),
      minutes: minutes === '' ? undefined : Number(minutes),
      day: day || undefined,
      start: start || undefined,
      due: due || undefined,
    };
    const taskError = validateTask(task);
    if (taskError) {
      setError(lang(TASK_ERROR_KEYS[taskError]));
      return;
    }
    if (slot && !fitsBookingWindow(state, slot, task)) {
      setError(lang('PlannerErrorOutsideWindow', { from: toTime(slot.start), to: toTime(slot.end) }));
      return;
    }
    const taskId = state.nextId;
    updatePlanner((draft) => {
      draft.tasks.push({
        ...task,
        id: draft.nextId++,
        description: description.trim(),
        steps: [],
        status,
        project,
        // Новая задача — первой в очереди
        rank: Math.min(0, ...draft.tasks.map(({ rank }) => rank)) - 1,
      });
    }, lang('PlannerNoticeAdded', { name: task.name }));
    onCreated(taskId);
  });

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {slot && (
        <p className={styles.summary}>
          {lang('PlannerBookingHint', {
            date: formatDay(lang, slot.day),
            from: toTime(slot.start),
            to: toTime(slot.end),
            duration: formatDuration(lang, slot.end - slot.start),
          })}
        </p>
      )}
      <Select label={lang('PlannerFieldKind')} value={kind} hasArrow onChange={handleKindChange}>
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
            <PlannerField label={lang('PlannerFieldWorkDate')} type="date" value={day} onInput={setDay} />
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
            <PlannerField label={lang('PlannerFieldDue')} type="date" value={due} onInput={setDue} />
          </div>
          <div className={styles.fields}>
            <Select label={lang('PlannerFieldStatus')} value={status} hasArrow onChange={handleStatusChange}>
              {PLANNER_STATUSES.map((item) => <option key={item} value={item}>{formatStatus(lang, item)}</option>)}
            </Select>
            <Select label={lang('PlannerFieldList')} value={project} hasArrow onChange={handleProjectChange}>
              {state.projects.map((item) => <option key={item} value={item}>{formatProject(lang, item)}</option>)}
            </Select>
          </div>
        </>
      ) : (
        <>
          <div className={styles.fields}>
            <PlannerField label={lang('PlannerFieldStart')} type="time" value={start} onInput={setStart} />
            <PlannerField label={lang('PlannerFieldEnd')} type="time" value={end} onInput={setEnd} />
          </div>
          <Checkbox label={lang('PlannerEventRepeatWeekly')} checked={isRepeating} onCheck={setIsRepeating} />
          {isRepeating ? (
            <div className={styles.weekdays}>
              {WEEKDAYS.map((weekday) => (
                <Checkbox
                  key={weekday}
                  value={String(weekday)}
                  label={formatWeekday(lang, (weekday + 6) % 7)}
                  checked={weekdays.includes(weekday)}
                  onChange={handleWeekdayToggle}
                />
              ))}
            </div>
          ) : (
            <PlannerField label={lang('PlannerFieldEventDate')} type="date" value={day} onInput={setDay} />
          )}
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
