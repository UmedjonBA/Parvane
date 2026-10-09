import { memo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatWeekday, listColorStyle } from './plannerFormat';
import {
  fromDayKey, getDeadlines, getEventsForDay, getListColor, getTasksForDay, getTimedForDay, instanceKey, isHolidayOn,
  layoutTimed, toMinutes, toTime,
} from './plannerModel';

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
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

const MINUTES_IN_HOUR = 60;
// Высота часа в сетке, rem
const HOUR_REM = 3;
const MIN_BLOCK_REM = 1.25;

// Виды «Неделя» и «День»: сетка по часам; дела без времени, события на весь день и
// дедлайны — строкой над сеткой. Пересекающиеся дела стоят рядом
const PlannerWeek = ({
  state, days, picked, today, onPickDay, onCreateForDay, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  const handleColumnDoubleClick = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('[data-kind]')) return;
    onCreateForDay(e.currentTarget.dataset.day!);
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
      className={buildClassName(styles.week, days.length === 1 && styles.weekSingle)}
      style={`--planner-week-days: ${days.length}; --planner-hour: ${HOUR_REM}rem`}
      data-planner-view={days.length === 1 ? 'day' : 'week'}
    >
      <div className={styles.weekHead}>
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
            onClick={handleDayClick}
            onDoubleClick={handleColumnDoubleClick}
          >
            {layout.map(({ item, lane, lanes }) => {
              const start = toMinutes(item.start);
              const top = ((start - gridStart) / MINUTES_IN_HOUR) * HOUR_REM;
              const height = Math.max(MIN_BLOCK_REM, ((toMinutes(item.end) - start) / MINUTES_IN_HOUR) * HOUR_REM);
              const position = `top: ${top}rem; height: ${height}rem; `
                + `inset-inline-start: ${(lane / lanes) * 100}%; width: ${100 / lanes}%`;
              const color = item.task ? listColorStyle(getListColor(state, item.task.project)) : undefined;
              return (
                <button
                  key={item.task ? `t${instanceKey(item.task)}` : `e${instanceKey(item.event!)}`}
                  type="button"
                  className={buildClassName(
                    styles.weekBlock,
                    item.event && styles.weekBlockEvent,
                    item.task?.status === 'done' && styles.agendaDone,
                  )}
                  style={color ? `${position}; ${color}` : position}
                  title={`${item.start}–${item.end} ${item.name}`}
                  data-kind={item.task ? 'task' : 'event'}
                  data-id={item.task ? item.task.id : item.event!.id}
                  data-day={day}
                  onClick={handleItemClick}
                >
                  <span className={styles.weekBlockTime}>{item.start}</span>
                  {item.name}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default memo(PlannerWeek);
