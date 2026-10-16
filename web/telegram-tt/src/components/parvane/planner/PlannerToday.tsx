import { memo, useMemo, useRef } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatHours, formatHoursNumber, formatSpan, formatStatus,
} from './plannerFormat';
import {
  getDailyRecord, getDayBudget, getSleepRoutine, isShortSleep,
} from './plannerHealth';
import { ALL_LAYERS } from './plannerLayers';
import {
  getDayEntry, getGoalsForDay, getListColor, getNutrientTotal, getUndatedTasks, instanceKey,
} from './plannerModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PvResizer, { PLANNER_SIDE_MAX, PLANNER_SIDE_MIN } from '../notes/PvResizer';
import PlannerDailyNote from './PlannerDailyNote';
import PlannerDayFeed from './PlannerDayFeed';
import PlannerTaskRow from './PlannerTaskRow';
import PlannerUndated from './PlannerUndated';

import styles from './Planner.module.scss';

// Сколько задач без даты показывать прямо в карточке «Задачи»
const UNDATED_SHOWN = 5;

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  // Узкий экран: расписание дня стоит между карточками и задачами, на широком — правой колонкой
  isNarrow: boolean;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  onOpenCalendar: NoneToVoidFunction;
  onOpenHealth: NoneToVoidFunction;
  // Ввод текстом с готовым началом строки
  onQuick: (text: string) => void;
};

const PERCENT = 100;

function share(value: number, goal?: number) {
  return goal ? Math.min(1, value / goal) * PERCENT : 0;
}

// «Сегодня»: сводка дня четырьмя карточками, расписание списком, задачи дня и «в работе», заметка дня
const PlannerToday = ({
  state, day, today, isNarrow, onOpenTask, onOpenEvent, onOpenCalendar, onOpenHealth, onQuick,
}: OwnProps) => {
  const tasksRef = useRef<HTMLElement>();
  const [isUndatedOpen, openUndated, closeUndated] = useFlag();

  const lang = useLang();

  // Дела дня — из индекса; несделанные — первыми, дальше по времени начала; без времени — в конце
  const entry = getDayEntry(state, day);
  const tasks = useMemo(() => [...entry.tasks].sort((a, b) => (
    Number(a.status === 'done') - Number(b.status === 'done') || (a.start || '99').localeCompare(b.start || '99')
  )), [entry]);
  const undated = useMemo(() => getUndatedTasks(state), [state]);
  const active = useMemo(() => undated.filter(({ status }) => status === 'active'), [undated]);
  // Задачи без даты в очереди — видны сразу (первые несколько), остальные — в окне «Без даты»
  const queued = useMemo(() => undated.filter(({ status }) => status === 'queue'), [undated]);
  const shownQueued = queued.slice(0, UNDATED_SHOWN);
  const doneCount = tasks.filter(({ status }) => status === 'done').length;
  const leftCount = tasks.length - doneCount;
  const load = entry.minutes;
  const budget = getDayBudget(state, day);
  const isOver = load > budget;
  const isShort = isShortSleep(state, day);
  const sleep = getDailyRecord(state, 'sleep', day);
  const sleepGoal = state.healthGoals.sleepMinutes;
  // Режим сна только сообщается: бюджет дня снижает один короткий сон
  const routine = useMemo(() => getSleepRoutine(state, day), [state, day]);
  const routineHint = routine.level === 'drifting' || routine.level === 'broken'
    ? lang(routine.level === 'drifting' ? 'PlannerSleepRoutineDriftingShort' : 'PlannerSleepRoutineBrokenShort', {
      value: lang('PlannerMinutesValue', { minutes: routine.spread! }),
    }) : undefined;
  const kcal = Math.round(getNutrientTotal(state, day, 'kcal').value);
  const kcalGoal = getGoalsForDay(state, day, today).kcal?.target;

  const handleTasksClick = useLastCallback(() => {
    tasksRef.current?.scrollIntoView({ block: 'start' });
  });

  // «+» карточки «Задачи» — задача на показанный день: без даты в строке она ушла бы в «Без даты»
  const handleAddTask = useLastCallback(() => {
    const [, month, date] = day.split('-');
    const dayWord = day === today ? lang('PlannerToday').toLowerCase() : `${date}.${month}`;
    onQuick(`${lang('PlannerKindTask').toLowerCase()} ${dayWord} `);
  });

  const handleAddMeal = useLastCallback(() => {
    onQuick(`${lang('PlannerMealLunch').toLowerCase()} `);
  });

  const feedCard = (
    <section className={styles.card} data-today-schedule>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{lang('PlannerSchedule')}</h3>
        <span className={styles.grow} />
        <button type="button" className={buildClassName(styles.btn, styles.btnGhost)} onClick={handleAddMeal}>
          <Icon name="eats" />
          {lang('PlannerHealthFood')}
        </button>
      </div>
      <PlannerDayFeed
        state={state}
        day={day}
        today={today}
        layers={ALL_LAYERS}
        onOpenTask={onOpenTask}
        onOpenEvent={onOpenEvent}
      />
    </section>
  );

  return (
    <div className={styles.todayGrid} data-planner-today={day}>
      <div className={styles.stack}>
        <div className={styles.stats}>
          <button
            type="button"
            className={buildClassName(styles.card, styles.stat, isShort ? styles.kindDue : styles.kindSleep)}
            data-today-card="sleep"
            data-sleep-routine-level={routine.level}
            onClick={onOpenHealth}
          >
            <span className={styles.statLabel}>{lang('PlannerHealthSleep')}</span>
            <span className={styles.statValue}>{sleep ? formatSpan(sleep.value) : '—'}</span>
            <span className={styles.prog}>
              <span className={styles.progFill} style={`width: ${sleep ? share(sleep.value, sleepGoal) : 0}%`} />
            </span>
            <span className={styles.statSub}>
              {!sleep ? lang('PlannerHealthSleepNone')
                : routineHint || (sleep.time && sleep.endTime && sleepGoal
                  ? lang('PlannerHealthSleepGoal', {
                    from: sleep.time, to: sleep.endTime, goal: formatSpan(sleepGoal),
                  })
                  : sleepGoal ? lang('PlannerHealthGoalValue', { value: formatSpan(sleepGoal) }) : '')}
            </span>
          </button>
          <button
            type="button"
            className={buildClassName(styles.card, styles.stat, styles.kindFood)}
            data-today-card="food"
            onClick={onOpenHealth}
          >
            <span className={styles.statLabel}>{lang('PlannerHealthFood')}</span>
            <span className={styles.statValue}>
              {lang.number(kcal)}
              <small className={styles.statUnit}>{` ${lang('PlannerHealthKcal', { value: '' }).trim()}`}</small>
            </span>
            <span className={styles.prog}>
              <span className={styles.progFill} style={`width: ${share(kcal, kcalGoal)}%`} />
            </span>
            <span className={styles.statSub}>
              {!kcalGoal ? '' : kcal > kcalGoal
                ? lang('PlannerHealthKcalOver', { value: lang.number(kcal - kcalGoal) })
                : lang('PlannerKcalLeftOf', { left: lang.number(kcalGoal - kcal), goal: lang.number(kcalGoal) })}
            </span>
          </button>
          <button
            type="button"
            className={buildClassName(styles.card, styles.stat, styles.kindTask)}
            data-today-card="tasks"
            onClick={handleTasksClick}
          >
            <span className={styles.statLabel}>{lang('PlannerViewTasks')}</span>
            <span className={styles.statValue}>
              {doneCount}
              <small className={styles.statUnit}>{` / ${tasks.length}`}</small>
            </span>
            <span className={styles.prog}>
              <span className={styles.progFill} style={`width: ${share(doneCount, tasks.length)}%`} />
            </span>
            <span className={styles.statSub}>
              {!tasks.length ? lang('PlannerTodayNoTasks')
                : leftCount ? lang('PlannerTodayLeft', { count: leftCount }) : lang('PlannerTodayAllDone')}
            </span>
          </button>
          <button
            type="button"
            className={buildClassName(styles.card, styles.stat, isOver ? styles.kindDue : styles.kindEvent)}
            data-today-card="load"
            onClick={onOpenCalendar}
          >
            <span className={styles.statLabel}>{lang('ParvaneSectionPlanner')}</span>
            <span className={styles.statValue}>
              {formatHoursNumber(lang, load)}
              <small className={styles.statUnit}>{` / ${formatHours(lang, budget)}`}</small>
            </span>
            <span className={styles.prog}>
              <span className={styles.progFill} style={`width: ${share(load, budget)}%`} />
            </span>
            <span className={styles.statSub}>
              {lang(isOver ? 'PlannerTodayOver' : isShort ? 'PlannerHealthBudgetReduced' : 'PlannerTodayLoad')}
            </span>
          </button>
        </div>
        {isNarrow && feedCard}
        <section ref={tasksRef} className={styles.card} data-today-tasks>
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>{lang('PlannerViewTasks')}</h3>
            <span className={styles.grow} />
            <button type="button" className={styles.ib} aria-label={lang('PlannerNewTask')} onClick={handleAddTask}>
              <Icon name="add" />
            </button>
          </div>
          {!tasks.length && !active.length && !queued.length && (
            <p className={styles.muted}>{lang('PlannerTodayNoTasks')}</p>
          )}
          {tasks.map((task) => (
            <PlannerTaskRow
              key={instanceKey(task)}
              task={task}
              context="day"
              color={getListColor(state, task.project)}
              onOpen={onOpenTask}
            />
          ))}
          {Boolean(active.length) && <h4 className={styles.groupTitle}>{formatStatus(lang, 'active')}</h4>}
          {active.map((task) => (
            <PlannerTaskRow
              key={task.id}
              task={task}
              context="day"
              color={getListColor(state, task.project)}
              onOpen={onOpenTask}
            />
          ))}
          {Boolean(shownQueued.length) && <h4 className={styles.groupTitle}>{lang('PlannerUndatedShort')}</h4>}
          {shownQueued.map((task) => (
            <PlannerTaskRow
              key={task.id}
              task={task}
              context="day"
              color={getListColor(state, task.project)}
              onOpen={onOpenTask}
            />
          ))}
          {Boolean(undated.length) && (
            <button
              type="button"
              className={buildClassName(styles.row, styles.rowButton, styles.rowUndated)}
              data-today-undated
              onClick={openUndated}
            >
              <span className={styles.rowIcon}><Icon name="archive" /></span>
              <span className={buildClassName(styles.grow, styles.rowTitle)}>{lang('PlannerUndatedAll')}</span>
              <span className={styles.rowMeta}>{undated.length}</span>
              <Icon name="next" />
            </button>
          )}
        </section>
        <PlannerDailyNote day={day} />
      </div>
      {!isNarrow && (
        <div className={buildClassName(styles.stack, styles.todaySide)}>
          <PvResizer
            panel="planner-today"
            edge="start"
            min={PLANNER_SIDE_MIN}
            max={PLANNER_SIDE_MAX}
            className={styles.todayResizer}
          />
          {feedCard}
        </div>
      )}
      <PlannerUndated
        isOpen={isUndatedOpen}
        state={state}
        day={day}
        today={today}
        tasks={undated}
        onOpenTask={onOpenTask}
        onClose={closeUndated}
      />
    </div>
  );
};

export default memo(PlannerToday);
