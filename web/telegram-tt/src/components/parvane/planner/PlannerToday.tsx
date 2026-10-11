import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useMemo, useRef } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import { formatHours, formatStatus } from './plannerFormat';
import {
  getDayLoad, getListColor, getLoadFraction, getTasksForDay, getUndatedTasks, instanceKey,
} from './plannerModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerTaskRow from './PlannerTaskRow';
import PlannerUndated from './PlannerUndated';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  // Узкий экран: расписание дня стоит между карточками и задачами
  schedule?: TeactNode;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenCalendar: NoneToVoidFunction;
};

const PERCENT = 100;

// «Сегодня» (spec 018): сводка дня карточками, задачи дня и задачи без даты
const PlannerToday = ({
  state, day, schedule, onOpenTask, onOpenCalendar,
}: OwnProps) => {
  const tasksRef = useRef<HTMLElement>();
  const [isUndatedOpen, openUndated, closeUndated] = useFlag();

  const lang = useLang();

  const tasks = useMemo(() => getTasksForDay(state, day), [state, day]);
  const undated = useMemo(() => getUndatedTasks(state), [state]);
  const active = undated.filter(({ status }) => status === 'active');
  const doneCount = tasks.filter(({ status }) => status === 'done').length;
  const leftCount = tasks.length - doneCount;
  const load = getDayLoad(state, day);
  const isOver = load > state.budget;

  const handleTasksClick = useLastCallback(() => {
    tasksRef.current?.scrollIntoView({ block: 'start' });
  });

  return (
    <div className={styles.today} data-planner-today={day}>
      <div className={styles.todayCards}>
        <button type="button" className={styles.todayCard} data-today-card="tasks" onClick={handleTasksClick}>
          <span className={styles.todayCardLabel}>{lang('PlannerViewTasks')}</span>
          <span className={styles.todayCardValue}>{`${doneCount} / ${tasks.length}`}</span>
          <span className={styles.todayBar}>
            <span
              className={styles.todayBarFill}
              style={`width: ${tasks.length ? (doneCount / tasks.length) * PERCENT : 0}%`}
            />
          </span>
          <span className={styles.small}>
            {!tasks.length ? lang('PlannerTodayNoTasks')
              : leftCount ? lang('PlannerTodayLeft', { count: leftCount }) : lang('PlannerTodayAllDone')}
          </span>
        </button>
        <button type="button" className={styles.todayCard} data-today-card="load" onClick={onOpenCalendar}>
          <span className={styles.todayCardLabel}>{lang('ParvaneSectionPlanner')}</span>
          <span className={styles.todayCardValue}>
            {`${formatHours(lang, load)} / ${formatHours(lang, state.budget)}`}
          </span>
          <span className={styles.todayBar}>
            <span
              className={isOver ? styles.todayBarOver : styles.todayBarFill}
              style={`width: ${getLoadFraction(state, load) * PERCENT}%`}
            />
          </span>
          <span className={styles.small}>{lang(isOver ? 'PlannerTodayOver' : 'PlannerTodayLoad')}</span>
        </button>
      </div>
      {schedule}
      <section ref={tasksRef} className={styles.todaySection} data-today-tasks>
        <h3 className={styles.group}>{lang('PlannerViewTasks')}</h3>
        {!tasks.length && <p className={styles.small}>{lang('PlannerTodayNoTasks')}</p>}
        {tasks.map((task) => (
          <PlannerTaskRow
            key={instanceKey(task)}
            task={task}
            context="day"
            color={getListColor(state, task.project)}
            onOpen={onOpenTask}
          />
        ))}
        {Boolean(active.length) && <h3 className={styles.group}>{formatStatus(lang, 'active')}</h3>}
        {active.map((task) => (
          <PlannerTaskRow
            key={task.id}
            task={task}
            context="all"
            color={getListColor(state, task.project)}
            onOpen={onOpenTask}
          />
        ))}
        {Boolean(undated.length) && (
          <button type="button" className={styles.todayUndated} data-today-undated onClick={openUndated}>
            {lang('PlannerUndated', { count: undated.length })}
          </button>
        )}
      </section>
      <PlannerUndated
        isOpen={isUndatedOpen}
        state={state}
        day={day}
        tasks={undated}
        onOpenTask={onOpenTask}
        onClose={closeUndated}
      />
    </div>
  );
};

export default memo(PlannerToday);
