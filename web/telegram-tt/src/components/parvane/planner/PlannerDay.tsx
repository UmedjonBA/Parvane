import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, formatRelativeDay } from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import {
  getDayEntry, getListColor, getUndatedTasks, instanceKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PlannerDailyNote from './PlannerDailyNote';
import PlannerDayFeed from './PlannerDayFeed';
import PlannerDayTags from './PlannerDayTags';
import PlannerLoad from './PlannerLoad';
import PlannerTaskRow from './PlannerTaskRow';
import PlannerWeek from './PlannerWeek';

import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  layers: PlannerLayers;
  // Телефон: день списком; компьютер: шкала часов и колонка справа
  isNarrow: boolean;
  // Колонка справа занята карточкой записи — остаётся одна шкала
  noAside?: boolean;
  onPickDay: (day: string) => void;
  onCreateForDay: (day: string) => void;
  onCreateAt: (day: string, start: number) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  onOpenSleep: (day: string) => void;
  onOpenUndated: NoneToVoidFunction;
  // Ввод текстом с готовым началом строки
  onQuick: (text: string) => void;
  // Задача, брошенная на шкалу дня (компьютер)
  onPlaceTask: (taskKey: string, day: string, minute: number) => void;
};

// Сколько задач без даты из очереди показывать прямо в дне
const UNDATED_SHOWN = 5;

// Вид «День» (доски `PhonePlan`, `RdPlan`): загрузка дня, дела по времени, задачи без времени (вместе с
// задачами «в работе» без даты), «Без даты» и заметка дня
const PlannerDay = ({
  state, day, today, layers, isNarrow, noAside, onPickDay, onCreateForDay, onCreateAt, onOpenTask, onOpenEvent,
  onOpenSleep, onOpenUndated, onQuick, onPlaceTask,
}: OwnProps) => {
  const lang = useLang();

  const entry = getDayEntry(state, day);
  const undated = useMemo(() => getUndatedTasks(state), [state]);
  const active = useMemo(() => undated.filter(({ status }) => status === 'active'), [undated]);
  // Задачи без даты в очереди — первые несколько видны сразу, остальные — в окне «Без даты»
  const queued = useMemo(() => (
    undated.filter(({ status }) => status === 'queue').slice(0, UNDATED_SHOWN)
  ), [undated]);
  const untimed = layers.work ? entry.untimed : [];
  const days = useMemo(() => [day], [day]);
  const hasUntimed = Boolean(untimed.length || active.length || queued.length);

  // «+» у задач без времени — задача на показанный день: без даты в строке она ушла бы в «Без даты»
  const handleAddTask = useLastCallback(() => {
    const [, month, date] = day.split('-');
    const dayWord = day === today ? lang('PlannerToday').toLowerCase() : `${date}.${month}`;
    onQuick(`${lang('PlannerKindTask').toLowerCase()} ${dayWord} `);
  });

  const untimedHead = (
    <div className={pv.capRow}>
      <h3 className={buildClassName(pv.cap, pv.capFlush)}>{lang('PlannerDayUntimed')}</h3>
      <button type="button" className={pv.navButton} aria-label={lang('PlannerNewTask')} onClick={handleAddTask}>
        <Icon name="add" />
      </button>
    </div>
  );

  const untimedRows = (
    <div className={pv.dayCard} data-today-untimed>
      {!hasUntimed && <p className={pv.dayEmpty}>{lang('PlannerTodayNoTasks')}</p>}
      {untimed.map((task) => (
        <PlannerTaskRow
          key={instanceKey(task)}
          task={task}
          context="day"
          color={getListColor(state, task.project)}
          onOpen={onOpenTask}
        />
      ))}
      {[...active, ...queued].map((task) => (
        <PlannerTaskRow
          key={task.id}
          task={task}
          context="all"
          color={getListColor(state, task.project)}
          onOpen={onOpenTask}
        />
      ))}
    </div>
  );

  const undatedButton = Boolean(undated.length) && (
    <button type="button" className={pv.wideButton} data-today-undated onClick={onOpenUndated}>
      {lang('PlannerUndated', { count: undated.length })}
    </button>
  );

  if (isNarrow) {
    return (
      <div className={pv.dayRoot} data-planner-today={day}>
        <div className={pv.dayList} data-today-tasks>
          <PlannerLoad
            title={`${formatRelativeDay(lang, day, today)}, ${formatDayLong(lang, day).toLowerCase()}`}
            minutes={entry.minutes}
            budget={getDayBudget(state, day)}
            withFree
          />
          <PlannerDayTags state={state} day={day} layers={layers} onOpenTask={onOpenTask} />
          <h3 className={buildClassName(pv.cap, pv.capFlush)}>{lang('PlannerDayTimed')}</h3>
          <div className={pv.dayCard} data-today-schedule>
            <PlannerDayFeed
              state={state}
              day={day}
              today={today}
              layers={layers}
              onOpenTask={onOpenTask}
              onOpenEvent={onOpenEvent}
              onOpenSleep={onOpenSleep}
            />
          </div>
          {untimedHead}
          {untimedRows}
          {undatedButton}
          <PlannerDailyNote day={day} />
        </div>
      </div>
    );
  }

  return (
    <div className={pv.dayRoot} data-planner-today={day}>
      <div className={pv.dayDesk} data-today-tasks>
        <div className={buildClassName(pv.dayGrid, 'custom-scroll')} data-today-schedule>
          <PlannerWeek
            state={state}
            days={days}
            picked={day}
            today={today}
            layers={layers}
            onPickDay={onPickDay}
            onCreateForDay={onCreateForDay}
            onCreateAt={onCreateAt}
            onOpenTask={onOpenTask}
            onOpenEvent={onOpenEvent}
            onOpenSleep={onOpenSleep}
            onPlaceTask={onPlaceTask}
          />
        </div>
        {!noAside && (
          <aside className={buildClassName(pv.dayAside, 'custom-scroll')} data-planner-day-aside>
            <PlannerDayTags state={state} day={day} layers={layers} onOpenTask={onOpenTask} />
            <PlannerDayFeed
              state={state}
              day={day}
              today={today}
              layers={layers}
              scope="allDay"
              onOpenTask={onOpenTask}
              onOpenEvent={onOpenEvent}
            />
            {untimedHead}
            {untimedRows}
            {hasUntimed && <p className={pv.hint} data-drag-hint>{lang('PlannerDragToGrid')}</p>}
            {undatedButton}
            <PlannerDailyNote day={day} />
          </aside>
        )}
      </div>
    </div>
  );
};

export default memo(PlannerDay);
