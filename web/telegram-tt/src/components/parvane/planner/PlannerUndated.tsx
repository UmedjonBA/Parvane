import { memo, useMemo, useRef } from '../../../lib/teact/teact';

import type { PlannerState, PlannerTask } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDayShort, formatProject, listColorStyle,
} from './plannerFormat';
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
  today: string;
  tasks: PlannerTask[];
  onOpenTask: (taskId: string, day?: string) => void;
  onClose: NoneToVoidFunction;
};

// Задачи без даты (spec 018): по спискам, «в работе» сверху группы; кнопка справа назначает день
const PlannerUndated = ({
  isOpen, state, day, today, tasks, onOpenTask, onClose,
}: OwnProps) => {
  const lang = useLang();

  const dayLabel = formatDay(lang, day);
  const assignLabel = day === today ? lang('PlannerToday') : formatDayShort(lang, day);
  // Группы и завершённые считаются, только пока окно открыто (закрытое перерисовывается с каждым состоянием
  // вместе с экраном «Сегодня»); пока окно уходит, показано посчитанное в последний раз
  const shownRef = useRef<{ projects: string[]; completed: PlannerTask[] }>({ projects: [], completed: [] });
  const { projects, completed } = useMemo(() => {
    if (isOpen) {
      shownRef.current = {
        projects: state.projects.filter((project) => tasks.some((task) => task.project === project)),
        completed: getCompletedTasks(state),
      };
    }
    return shownRef.current;
  }, [isOpen, state, tasks]);

  const handleAssign = useLastCallback((taskId: string) => {
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
      title={lang('PlannerUndated', { count: tasks.length })}
      className={styles.sheet}
      hasCloseButton
      onClose={onClose}
    >
      <div className={styles.sheetBody} data-planner-undated>
        <p className={styles.sheetHint}>{lang('PlannerUndatedHint')}</p>
        {!tasks.length && <p className={styles.muted}>{lang('PlannerUndatedEmpty')}</p>}
        {projects.map((project) => {
          const projectTasks = tasks.filter((task) => task.project === project);
          return (
            <section key={project} data-project={project}>
              <h3
                className={buildClassName(styles.groupTitle, styles.groupTitleFirst)}
                style={listColorStyle(getListColor(state, project))}
              >
                <span className={styles.listMark} />
                {formatProject(lang, project)}
                <span className={styles.groupCount}>{projectTasks.length}</span>
              </h3>
              {projectTasks.map((task) => (
                <PlannerTaskRow
                  key={task.id}
                  task={task}
                  context="all"
                  noProject
                  assignLabel={assignLabel}
                  assignTitle={lang('PlannerUndatedAssign', { date: dayLabel, name: task.name })}
                  onAssign={handleAssign}
                  onOpen={handleOpen}
                />
              ))}
            </section>
          );
        })}
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
