import { memo, useMemo } from '../../../lib/teact/teact';

import type {
  PlannerDayIndexEntry, PlannerEvent, PlannerState, PlannerTask,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDuration, formatProject, formatRelativeDay, listColorStyle,
} from './plannerFormat';
import { formatDescriptionLine } from './plannerLinks';
import {
  addDays, AGENDA_DAYS, getDayIndex, getListColor, instanceKey, toMinutes, toTime,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerName from './PlannerName';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  // Первый день списка
  day: string;
  today: string;
  onPickDay: (day: string) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

// Вид «Список» (spec 018): повестка на 30 дней от выбранного дня, пустые дни пропущены. Строка — время и
// блок цвета записи; срок задачи — красной строкой
const PlannerAgenda = ({
  state, day, today, onPickDay, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const days = useMemo(() => {
    const lastDay = addDays(day, AGENDA_DAYS - 1);
    const index = getDayIndex(state, day, lastDay);
    return [...index.entries()]
      .filter(([, entry]) => entry.tasks.length + entry.events.length + entry.deadlines.length)
      .sort(([a], [b]) => (a < b ? -1 : 1));
  }, [state, day]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  const handleEventClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenEvent(e.currentTarget.dataset.eventId!, e.currentTarget.dataset.day!);
  });

  const handleTaskClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTask(e.currentTarget.dataset.taskId!, e.currentTarget.dataset.instanceDay);
  });

  const renderEvent = (event: PlannerEvent, dayKey: string) => (
    <div key={`e${instanceKey(event)}`} className={styles.feedLine}>
      <span className={styles.feedTime}>{event.isAllDay ? lang('PlannerAllDayTiny') : event.start}</span>
      <div
        className={buildClassName(styles.feedBlock, event.isHoliday ? styles.kindDue : styles.kindEvent)}
        style={listColorStyle(event.color)}
      >
        <button
          type="button"
          className={styles.feedBlockOpen}
          data-event-id={event.id}
          data-day={dayKey}
          onClick={handleEventClick}
        >
          <span className={styles.feedBlockName}><PlannerName name={event.name} /></span>
          <span className={styles.feedBlockSub}>
            {event.isAllDay ? lang(event.isHoliday ? 'PlannerHoliday' : 'PlannerAllDay')
              : `${event.start}–${event.end}`}
            {event.repeat ? ` · ${lang('PlannerRepeatMark')}` : ''}
          </span>
          {event.description && (
            <span className={styles.feedBlockNote} data-block-note>{formatDescriptionLine(event.description)}</span>
          )}
        </button>
      </div>
    </div>
  );

  const renderTask = (task: PlannerTask) => {
    const isTimed = Boolean(task.start) && task.minutes !== undefined;
    return (
      <div key={`t${instanceKey(task)}`} className={styles.feedLine}>
        <span className={styles.feedTime}>{task.start || '—'}</span>
        <div
          className={buildClassName(
            styles.feedBlock, styles.kindTask, task.status === 'done' && styles.feedBlockDone,
          )}
          style={listColorStyle(getListColor(state, task.project))}
        >
          <button
            type="button"
            className={styles.feedBlockOpen}
            data-task-id={task.id}
            data-instance-day={task.instanceDay}
            onClick={handleTaskClick}
          >
            <span className={styles.feedBlockName}><PlannerName name={task.name} /></span>
            <span className={styles.feedBlockSub}>
              {isTimed ? `${task.start}–${toTime(toMinutes(task.start!) + task.minutes!)}`
                : [
                  lang('PlannerKindTask').toLowerCase(),
                  task.minutes === undefined ? undefined : formatDuration(lang, task.minutes),
                ].filter(Boolean).join(' · ')}
              {task.repeat ? ` · ${lang('PlannerRepeatMark')}` : ''}
            </span>
            {task.description && (
              <span className={styles.feedBlockNote} data-block-note>{formatDescriptionLine(task.description)}</span>
            )}
          </button>
        </div>
      </div>
    );
  };

  // События на весь день — первыми, дальше события и задачи по времени начала, задачи без времени — в конце
  const renderDayRows = (entry: PlannerDayIndexEntry, dayKey: string) => [
    ...entry.events.map((event) => ({ order: event.isAllDay ? '' : event.start, node: renderEvent(event, dayKey) })),
    ...entry.tasks.map((task) => ({ order: task.start || '99', node: renderTask(task) })),
  ].sort((a, b) => a.order.localeCompare(b.order)).map(({ node }) => node);

  return (
    <div className={styles.agenda} data-planner-view="agenda">
      {!days.length && <p className={styles.empty}>{lang('PlannerAgendaEmpty')}</p>}
      {days.map(([key, entry]) => (
        <section key={key} className={styles.agendaDay} data-day={key}>
          <button
            type="button"
            className={buildClassName(
              styles.agendaDayTitle, key === today && styles.agendaDayToday, entry.isHoliday && styles.red,
            )}
            data-day={key}
            onClick={handleDayClick}
          >
            {`${formatRelativeDay(lang, key, today)}, ${formatDay(lang, key)}`}
          </button>
          {renderDayRows(entry, key)}
          {entry.deadlines.map((task) => (
            <div key={`due-${task.id}`} className={styles.feedLine}>
              <span className={buildClassName(styles.feedTime, styles.red)}>{lang('PlannerDueTiny')}</span>
              <div className={buildClassName(styles.feedBlock, styles.kindDue)}>
                <button
                  type="button"
                  className={styles.feedBlockOpen}
                  data-task-id={task.id}
                  onClick={handleTaskClick}
                >
                  <span className={styles.feedBlockName}><PlannerName name={task.name} /></span>
                  <span className={styles.feedBlockSub}>{formatProject(lang, task.project)}</span>
                </button>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};

export default memo(PlannerAgenda);
