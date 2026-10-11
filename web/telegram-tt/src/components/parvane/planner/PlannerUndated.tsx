import { memo } from '../../../lib/teact/teact';

import type { PlannerState, PlannerTask } from './plannerModel';

import { formatDay, formatProject, listColorStyle } from './plannerFormat';
import { getCompletedTasks, getListColor } from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Modal from '../../ui/Modal';
import PlannerTaskRow from './PlannerTaskRow';

import styles from './Planner.module.scss';

type OwnProps = {
  isOpen: boolean;
  state: PlannerState;
  // День, на который назначает кнопка у задачи
  day: string;
  tasks: PlannerTask[];
  onOpenTask: (taskId: string, day?: string) => void;
  onClose: NoneToVoidFunction;
};

// Задачи без даты (spec 018): по спискам, «в работе» сверху группы; кнопка справа назначает день
const PlannerUndated = ({
  isOpen, state, day, tasks, onOpenTask, onClose,
}: OwnProps) => {
  const lang = useLang();

  const dayLabel = formatDay(lang, day);
  const projects = state.projects.filter((project) => tasks.some((task) => task.project === project));
  const completed = isOpen ? getCompletedTasks(state) : [];

  const handleAssign = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const taskId = e.currentTarget.dataset.taskId!;
    const task = tasks.find(({ id }) => id === taskId)!;
    updatePlanner((draft) => {
      draft.tasks.find(({ id }) => id === taskId)!.day = day;
    }, lang('PlannerNoticeMoved', { date: dayLabel, name: task.name }));
  });

  const handleOpen = useLastCallback((taskId: string, taskDay?: string) => {
    onClose();
    onOpenTask(taskId, taskDay);
  });

  return (
    <Modal
      isOpen={isOpen}
      title={lang('PlannerUndatedTitle')}
      className={styles.sheet}
      hasCloseButton
      onClose={onClose}
    >
      <div className={styles.undated} data-planner-undated>
        {!tasks.length && <p className={styles.small}>{lang('PlannerUndatedEmpty')}</p>}
        {projects.map((project) => (
          <section key={project} className={styles.undatedGroup} data-project={project}>
            <h3 className={styles.undatedTitle}>
              <span className={styles.undatedDot} style={listColorStyle(getListColor(state, project))} />
              {formatProject(lang, project)}
            </h3>
            {tasks.filter((task) => task.project === project).map((task) => (
              <div key={task.id} className={styles.undatedRow}>
                <PlannerTaskRow task={task} context="all" noProject onOpen={handleOpen} />
                <button
                  type="button"
                  className={styles.undatedAssign}
                  data-task-id={task.id}
                  aria-label={lang('PlannerUndatedAssign', { date: dayLabel, name: task.name })}
                  onClick={handleAssign}
                >
                  {dayLabel}
                </button>
              </div>
            ))}
          </section>
        ))}
        {Boolean(completed.length) && (
          <details className={styles.fold}>
            <summary>{lang('PlannerCompleted', { count: completed.length })}</summary>
            {completed.map((task) => (
              <PlannerTaskRow
                key={task.id}
                task={task}
                context="all"
                color={getListColor(state, task.project)}
                onOpen={handleOpen}
              />
            ))}
          </details>
        )}
      </div>
    </Modal>
  );
};

export default memo(PlannerUndated);
