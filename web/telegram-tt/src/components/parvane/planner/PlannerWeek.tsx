import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatWeekday, listColorStyle } from './plannerFormat';
import {
  fromDayKey, getDeadlines, getEventsForDay, getListColor, getTasksForDay, getTimedForDay, instanceKey, isHolidayOn,
  layoutTimed, setTaskDone, toMinutes, toTime,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Семь дней недели либо один день
  days: string[];
  picked: string;
  today: string;
  onPickDay: (day: string) => void;
  onCreateForDay: (day: string) => void;
  // Панель дня: шапки с днём нет, нажатие на свободное время создаёт дело с этого времени
  isPanel?: boolean;
  // Вид «Неделя»: нажатие на свободное время создаёт дело в этом дне с этого времени
  isTapCreate?: boolean;
  onCreateAt?: (day: string, start: number) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

const MINUTES_IN_HOUR = 60;
// Высота часа в сетке, rem
const HOUR_REM = 3;
const MIN_BLOCK_REM = 1.25;
// Новое дело из сетки начинается с получаса и длится час
const CREATE_STEP = 30;
const CREATE_MINUTES = 60;

// Сетка по часам для недели и для панели дня; дела без времени, события на весь день и
// дедлайны — строкой над сеткой
const PlannerWeek = ({
  state, days, picked, today, isPanel, isTapCreate, onPickDay, onCreateForDay, onCreateAt, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const rootRef = useRef<HTMLDivElement>();

  // Неделя шире экрана (телефон): выбранный день должен быть на виду
  useEffect(() => {
    if (isPanel) return;
    rootRef.current?.querySelector(`button[data-day="${picked}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [isPanel, picked]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  const handleColumnDoubleClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('[data-kind]')) return;
    onCreateForDay(e.currentTarget.dataset.day!);
  });

  const handleColumnClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    const { day } = e.currentTarget.dataset;
    if (!(isPanel || isTapCreate) || !onCreateAt) {
      onPickDay(day!);
      return;
    }
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = gridStart + ((e.clientY - rect.top) / rect.height) * hours.length * MINUTES_IN_HOUR;
    const start = Math.floor(minutes / CREATE_STEP) * CREATE_STEP;
    onCreateAt(day!, Math.max(0, Math.min(start, hours.length * MINUTES_IN_HOUR + gridStart - CREATE_MINUTES)));
  });

  // Галочка в блоке задачи (панель дня): экземпляр ряда отмечается в своём дне
  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, day } = e.currentTarget.dataset;
    const { checked } = e.currentTarget;
    const task = getTasksForDay(state, day!).find((candidate) => candidate.id === id);
    if (!task) return;
    updatePlanner((draft) => {
      setTaskDone(draft, task, checked);
    }, lang(checked ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  const handleItemClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const { kind, id, day } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day!);
    else onOpenTask(id!, day);
  });

  const columns = days.map((day) => {
    const timed = getTimedForDay(state, day);
    return {
      day,
      layout: layoutTimed(timed),
      allDay: getEventsForDay(state, day).filter((event) => event.isAllDay),
      untimed: getTasksForDay(state, day).filter((task) => !task.start || task.minutes === undefined),
      deadlines: getDeadlines(state, day),
      isHoliday: isHolidayOn(state, day),
    };
  });
  // Сетка покрывает окна дня и всё, что выходит за них
  const starts = columns.flatMap((column) => column.layout.map(({ item }) => toMinutes(item.start)));
  const ends = columns.flatMap((column) => column.layout.map(({ item }) => toMinutes(item.end)));
  const firstHour = Math.floor(Math.min(state.settings.dayStart, ...starts) / MINUTES_IN_HOUR);
  const lastHour = Math.ceil(Math.max(state.settings.dayEnd, ...ends) / MINUTES_IN_HOUR);
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const gridStart = firstHour * MINUTES_IN_HOUR;

  return (
    <div
      ref={rootRef}
      className={buildClassName(styles.week, days.length === 1 && styles.weekSingle, isPanel && styles.weekPanel)}
      style={`--planner-week-days: ${days.length}; --planner-hour: ${HOUR_REM}rem`}
      data-planner-view={isPanel ? undefined : 'week'}
      data-day-grid={isPanel ? '1' : undefined}
    >
      <div className={buildClassName(styles.weekHead, isPanel && styles.weekHeadHidden)}>
        <span className={styles.weekCorner} />
        {columns.map(({ day, isHoliday }) => {
          const date = fromDayKey(day);
          return (
            <button
              key={day}
              type="button"
              className={buildClassName(
                styles.weekDayTitle,
                day === today && styles.weekDayToday,
                day === picked && styles.weekDayPicked,
                isHoliday && styles.weekDayHoliday,
              )}
              data-day={day}
              aria-label={formatDay(lang, day)}
              onClick={handleDayClick}
            >
              <span>{formatWeekday(lang, (date.getDay() + 6) % 7)}</span>
              <span className={styles.weekDayNumber}>{date.getDate()}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.weekAllDay}>
        <span className={styles.weekCorner}>{lang('PlannerAllDayShort')}</span>
        {columns.map(({
          day, allDay, untimed, deadlines,
        }) => (
          <div key={day} className={styles.weekAllDayCell} data-day={day}>
            {allDay.map((event) => (
              <button
                key={`e${instanceKey(event)}`}
                type="button"
                className={buildClassName(styles.weekChip, event.isHoliday && styles.weekChipHoliday)}
                title={event.name}
                data-kind="event"
                data-all-day={event.id}
                data-holiday={event.isHoliday ? '1' : undefined}
                data-id={event.id}
                data-day={day}
                onClick={handleItemClick}
              >
                {event.name}
              </button>
            ))}
            {untimed.map((task) => (
              <button
                key={`t${instanceKey(task)}`}
                type="button"
                className={buildClassName(styles.weekChip, task.status === 'done' && styles.agendaDone)}
                style={listColorStyle(getListColor(state, task.project))}
                title={task.name}
                data-kind="task"
                data-id={task.id}
                data-day={day}
                onClick={handleItemClick}
              >
                {task.name}
              </button>
            ))}
            {deadlines.map((task) => (
              <button
                key={`d${task.id}`}
                type="button"
                className={buildClassName(styles.weekChip, styles.previewDue)}
                title={task.name}
                data-kind="task"
                data-id={task.id}
                onClick={handleItemClick}
              >
                {lang('PlannerDeadlinePreview', { name: task.name })}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.weekBody}>
        <div className={styles.weekHours}>
          {hours.map((hour) => (
            <span key={hour} className={styles.weekHour}>{toTime(hour * MINUTES_IN_HOUR)}</span>
          ))}
        </div>
        {columns.map(({ day, layout }) => (
          <div
            key={day}
            className={buildClassName(styles.weekColumn, day === picked && styles.weekColumnPicked)}
            style={`height: ${hours.length * HOUR_REM}rem`}
            data-day={day}
            onClick={handleColumnClick}
            onDoubleClick={isPanel ? undefined : handleColumnDoubleClick}
          >
            {layout.map(({
              item, lane, lanes, right,
            }) => {
              const start = toMinutes(item.start);
              const top = ((start - gridStart) / MINUTES_IN_HOUR) * HOUR_REM;
              const height = Math.max(MIN_BLOCK_REM, ((toMinutes(item.end) - start) / MINUTES_IN_HOUR) * HOUR_REM);
              // Колонки пересечения; блок тянется вправо, пока не закрыл бы чужой заголовок (`layoutTimed`)
              const position = `top: ${top}rem; height: ${height}rem; z-index: ${lane + 1}; `
                + `inset-inline-start: ${(lane / lanes) * 100}%; width: ${((right - lane) / lanes) * 100}%`;
              const color = item.task ? listColorStyle(getListColor(state, item.task.project)) : undefined;
              const itemKey = item.task ? `t${instanceKey(item.task)}` : `e${instanceKey(item.event!)}`;
              return (
                <div
                  key={itemKey}
                  className={buildClassName(
                    styles.weekBlock,
                    item.event && styles.weekBlockEvent,
                    item.task?.status === 'done' && styles.agendaDone,
                  )}
                  style={color ? `${position}; ${color}` : position}
                  data-block={itemKey}
                  data-lane={lane}
                >
                  {isPanel && item.task && (
                    <input
                      type="checkbox"
                      className={styles.weekBlockCheck}
                      checked={item.task.status === 'done'}
                      aria-label={lang('PlannerAriaDone', { name: item.task.name })}
                      data-id={item.task.id}
                      data-day={day}
                      onChange={handleToggle}
                    />
                  )}
                  <button
                    type="button"
                    className={styles.weekBlockOpen}
                    title={`${item.start}–${item.end} ${item.name}`}
                    data-kind={item.task ? 'task' : 'event'}
                    data-id={item.task ? item.task.id : item.event!.id}
                    data-day={day}
                    onClick={handleItemClick}
                  >
                    <span className={styles.weekBlockName}>{item.name}</span>
                    <span className={styles.weekBlockTime}>
                      {isPanel ? `${item.start}–${item.end}` : item.start}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default memo(PlannerWeek);
