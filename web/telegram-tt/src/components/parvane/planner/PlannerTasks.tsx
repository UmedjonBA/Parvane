import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerState, PlannerStatus } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatProject, formatStatus } from './plannerFormat';
import { getCompletedTasks, getEligibleTasks, moveTask } from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import PlannerField from './PlannerField';
import PlannerTaskRow from './PlannerTaskRow';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  selectedProject: string;
  onSelectProject: (project: string) => void;
  onOpenTask: (taskId: number) => void;
  onCreateTask: NoneToVoidFunction;
};

const GROUP_ORDER: PlannerStatus[] = ['active', 'queue', 'waiting', 'later'];
const LIST_NAME_MAX_LENGTH = 60;

// Задачи без дедлайна по спискам; задачи с дедлайном живут в календаре
const PlannerTasks = ({
  state, selectedProject, onSelectProject, onOpenTask, onCreateTask,
}: OwnProps) => {
  const lang = useLang();

  const [newList, setNewList] = useState('');

  const handleListClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onSelectProject(e.currentTarget.dataset.project!);
  });

  const handleListSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = newList.trim();
    if (!name || state.projects.includes(name)) return;
    updatePlanner((draft) => {
      draft.projects.push(name);
    }, lang('PlannerNoticeListCreated', { name }));
    onSelectProject(name);
    setNewList('');
  });

  const handleReorder = useLastCallback((taskId: number, direction: -1 | 1) => {
    updatePlanner((draft) => {
      moveTask(draft, taskId, direction);
    }, lang('PlannerNoticeReordered'));
  });

  // Порядок — как в `getOrderedGroup`: по рангу, при равных — по id
  const subset = getEligibleTasks(state)
    .filter((task) => task.project === selectedProject)
    .sort((a, b) => a.rank - b.rank || a.id - b.id);
  const completed = getCompletedTasks(state);

  return (
    <div className={styles.lists}>
      <nav className={styles.listNav} aria-label={lang('PlannerAriaLists')}>
        {state.projects.map((project) => (
          <button
            key={project}
            type="button"
            className={buildClassName(styles.listButton, project === selectedProject && styles.listButtonActive)}
            aria-pressed={project === selectedProject}
            data-project={project}
            onClick={handleListClick}
          >
            {formatProject(lang, project)}
          </button>
        ))}
        <form className={styles.stepForm} onSubmit={handleListSubmit}>
          <PlannerField
            label={lang('PlannerNewList')}
            type="text"
            value={newList}
            maxLength={LIST_NAME_MAX_LENGTH}
            onInput={setNewList}
          />
          <Button type="submit" round size="smaller" iconName="add" ariaLabel={lang('PlannerCreateList')} />
        </form>
      </nav>
      <section className={styles.listBody}>
        <h3 className={styles.listTitle}>{formatProject(lang, selectedProject)}</h3>
        {!subset.length && <p className={styles.small}>{lang('PlannerListEmpty')}</p>}
        {GROUP_ORDER.map((status) => {
          const group = subset.filter((task) => task.status === status);
          if (!group.length) return undefined;
          return (
            <div key={status}>
              <h3 className={styles.group}>{formatStatus(lang, status)}</h3>
              {group.map((task, index) => (
                <PlannerTaskRow
                  key={task.id}
                  task={task}
                  context="all"
                  canMoveUp={index > 0}
                  canMoveDown={index < group.length - 1}
                  onOpen={onOpenTask}
                  onReorder={handleReorder}
                />
              ))}
            </div>
          );
        })}
        <Button isText size="smaller" className={styles.inlineAdd} onClick={onCreateTask}>
          {lang('PlannerAddTaskToList')}
        </Button>
        {Boolean(completed.length) && (
          <details className={styles.fold}>
            <summary>{lang('PlannerCompleted', { count: completed.length })}</summary>
            {completed.map((task) => <PlannerTaskRow key={task.id} task={task} context="all" onOpen={onOpenTask} />)}
          </details>
        )}
      </section>
    </div>
  );
};

export default memo(PlannerTasks);
