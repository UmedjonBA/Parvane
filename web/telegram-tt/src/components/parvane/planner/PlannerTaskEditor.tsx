import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerState, PlannerStatus, PlannerTask } from './plannerModel';

import {
  formatClock, formatDay, formatProject, formatStatus,
} from './plannerFormat';
import {
  findSlots, hasLunchBreak, MIN_TASK_MINUTES, MINUTES_IN_DAY, PLANNER_STATUSES, toMinutes,
} from './plannerModel';
import { showPlannerNotice, updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import Select from '../../ui/Select';
import TextArea from '../../ui/TextArea';
import PlannerField from './PlannerField';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  task: PlannerTask;
  today: string;
  picked: string;
  backLabel: string;
  onBack: NoneToVoidFunction;
  onPickDay: (day: string) => void;
};

type Slot = { day: string; start: string; end: string };

const STEP_MAX_LENGTH = 160;

const PlannerTaskEditor = ({
  state, task, today, picked, backLabel, onBack, onPickDay,
}: OwnProps) => {
  const lang = useLang();

  const [stepText, setStepText] = useState('');
  const [slots, setSlots] = useState<Slot[]>();
  const [slotHint, setSlotHint] = useState<string>();

  const patch = useLastCallback((changes: Partial<PlannerTask>, notice: string) => {
    updatePlanner((draft) => {
      const target = draft.tasks.find(({ id }) => id === task.id);
      if (target) Object.assign(target, changes);
    }, notice);
    setSlots(undefined);
  });

  const handleDay = useLastCallback((value: string) => {
    patch(value ? { day: value } : { day: undefined, start: undefined }, value
      ? lang('PlannerNoticeMoved', { date: formatDay(lang, value), name: task.name })
      : lang('PlannerNoticeUnscheduled', { name: task.name }));
  });

  const handleDue = useLastCallback((value: string) => {
    patch({ due: value || undefined }, lang('PlannerNoticeDueUpdated', { name: task.name }));
  });

  const handleStart = useLastCallback((value: string) => {
    if (value && !task.day) {
      showPlannerNotice(lang('PlannerErrorNeedDay'));
      return false;
    }
    if (value && !task.minutes) {
      showPlannerNotice(lang('PlannerErrorNeedMinutes'));
      return false;
    }
    if (value && toMinutes(value) + task.minutes! > MINUTES_IN_DAY) {
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

  const handleDescription = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const description = e.currentTarget.value;
    updatePlanner((draft) => {
      const target = draft.tasks.find(({ id }) => id === task.id);
      if (target) target.description = description;
    });
  });

  const handleStepToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const index = Number(e.currentTarget.value);
    const isDone = e.currentTarget.checked;
    patch(
      { steps: task.steps.map((step, i) => (i === index ? { ...step, isDone } : step)) },
      lang('PlannerNoticeStepUpdated', { name: task.steps[index].text }),
    );
  });

  const handleStepSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = stepText.trim();
    if (!text) return;
    patch({ steps: [...task.steps, { text, isDone: false }] }, lang('PlannerNoticeStepAdded'));
    setStepText('');
  });

  const handleStatus = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    patch({ status: e.currentTarget.value as PlannerStatus }, lang('PlannerNoticeStatusUpdated', { name: task.name }));
  });

  const handleProject = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    patch({ project: e.currentTarget.value }, lang('PlannerNoticeListUpdated', { name: task.name }));
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
    const hint = hasLunchBreak(settings)
      ? lang('PlannerSlotsHint', {
        window, lunch: `${formatClock(settings.lunchStart)}–${formatClock(settings.lunchEnd)}`, margin: settings.margin,
      })
      : lang('PlannerSlotsHintNoBreak', { window, margin: settings.margin });
    setSlotHint(found.length ? hint : lang('PlannerSlotsNone'));
  });

  const handleSlotClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const slot = slots![Number(e.currentTarget.dataset.index)];
    onPickDay(slot.day);
    patch(
      { day: slot.day, start: slot.start },
      lang('PlannerNoticeScheduled', { date: formatDay(lang, slot.day), time: slot.start }),
    );
  });

  const handleDelete = useLastCallback(() => {
    updatePlanner((draft) => {
      draft.tasks = draft.tasks.filter(({ id }) => id !== task.id);
    }, lang('PlannerNoticeTaskDeleted', { name: task.name }));
    onBack();
  });

  const doneSteps = task.steps.filter((step) => step.isDone).length;

  return (
    <div className={styles.editor}>
      <Button isText size="smaller" className={styles.back} iconName="arrow-left" onClick={onBack}>
        {backLabel}
      </Button>
      <h2 className={styles.editorTitle}>{task.name}</h2>
      <div className={styles.fields}>
        <PlannerField label={lang('PlannerFieldWorkDate')} type="date" value={task.day} onCommit={handleDay} />
        <PlannerField label={lang('PlannerFieldDue')} type="date" value={task.due} onCommit={handleDue} />
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
      <TextArea
        label={lang('PlannerFieldDescription')}
        value={task.description}
        onChange={handleDescription}
        noReplaceNewlines
      />
      <h3 className={styles.group}>{lang('PlannerSteps', { done: doneSteps, total: task.steps.length })}</h3>
      {task.steps.map((step, index) => (
        <Checkbox
          key={`${index}${step.text}`}
          value={String(index)}
          label={step.text}
          checked={step.isDone}
          onChange={handleStepToggle}
        />
      ))}
      <form className={styles.stepForm} onSubmit={handleStepSubmit}>
        <PlannerField
          label={lang('PlannerStepNew')}
          type="text"
          value={stepText}
          maxLength={STEP_MAX_LENGTH}
          onInput={setStepText}
        />
        <Button type="submit" round size="smaller" iconName="add" ariaLabel={lang('PlannerStepAdd')} />
      </form>
      <div className={styles.fields}>
        <Select label={lang('PlannerFieldStatus')} value={task.status} hasArrow onChange={handleStatus}>
          {PLANNER_STATUSES.map((item) => <option key={item} value={item}>{formatStatus(lang, item)}</option>)}
        </Select>
        <Select label={lang('PlannerFieldList')} value={task.project} hasArrow onChange={handleProject}>
          {state.projects.map((item) => <option key={item} value={item}>{formatProject(lang, item)}</option>)}
        </Select>
      </div>
      <Button size="smaller" color="translucent" onClick={handleFindSlots}>{lang('PlannerFindSlots')}</Button>
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
      <Button isText size="smaller" color="danger" onClick={handleDelete}>{lang('PlannerDeleteTask')}</Button>
    </div>
  );
};

export default memo(PlannerTaskEditor);
