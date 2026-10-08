import { memo } from '../../../lib/teact/teact';

import type { PlannerTask } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatProject } from './plannerFormat';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

export const TASK_DRAG_TYPE = 'application/x-parvane-planner-task';

type OwnProps = {
  task: PlannerTask;
  // `all` — строка в списках (дата или список в подписи), `day` — в расписании дня
  context: 'all' | 'day';
  onOpen: (taskId: number) => void;
};

const PlannerTaskRow = ({ task, context, onOpen }: OwnProps) => {
  const lang = useLang();

  const isDone = task.status === 'done';

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const status = e.currentTarget.checked ? 'done' : 'queue';
    updatePlanner((draft) => {
      const target = draft.tasks.find(({ id }) => id === task.id);
      if (target) target.status = status;
    }, lang(status === 'done' ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  const handleOpen = useLastCallback(() => {
    onOpen(task.id);
  });

  const handleDragStart = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_TYPE, String(task.id));
    e.dataTransfer.effectAllowed = 'move';
  });

  const meta = [task.minutes === undefined ? lang('PlannerNoEstimate') : lang('PlannerMinutesValue', {
    minutes: task.minutes,
  })];
  if (context === 'all') meta.push(task.day ? formatDay(lang, task.day) : formatProject(lang, task.project));
  if (task.due) meta.push(lang('PlannerDueValue', { date: formatDay(lang, task.due) }));
  if (task.steps.length) meta.push(`${task.steps.filter((step) => step.isDone).length}/${task.steps.length}`);

  return (
    <div
      className={buildClassName(styles.task, isDone && styles.taskDone)}
      draggable
      data-task-id={task.id}
      onDragStart={handleDragStart}
    >
      <input
        type="checkbox"
        className={styles.taskCheck}
        checked={isDone}
        aria-label={lang('PlannerAriaDone', { name: task.name })}
        onChange={handleToggle}
      />
      <button type="button" className={styles.taskButton} onClick={handleOpen}>
        <span className={styles.taskName}>{task.name}</span>
        <span className={styles.small}>{meta.join(' · ')}</span>
      </button>
    </div>
  );
};

export default memo(PlannerTaskRow);
