import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, listColorStyle } from './plannerFormat';
import {
  addDays, AGENDA_DAYS, buildDayIndex, getListColor, instanceKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  fromDay: string;
  today: string;
  onPickDay: (day: string) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

// Вид «Расписание»: дела ближайших дней списком по дням; дни без дел не показываются
const PlannerAgenda = ({
  state, fromDay, today, onPickDay, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const toDay = addDays(fromDay, AGENDA_DAYS - 1);
  const index = useMemo(() => buildDayIndex(state, fromDay, toDay), [state, fromDay, toDay]);
  const days = [...index.keys()].sort();

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  const handleRowClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id, day } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day!);
    else onOpenTask(id!, day);
  });

  if (!days.length) {
    return <p className={styles.summary} data-planner-view="agenda">{lang('PlannerAgendaEmpty')}</p>;
  }

  return (
    <div className={styles.agenda} data-planner-view="agenda">
      {days.map((day) => {
        const entry = index.get(day)!;
        return (
          <section key={day} className={styles.agendaDay} data-day={day}>
            <button
              type="button"
              className={buildClassName(
                styles.agendaDayTitle, day === today && styles.agendaDayToday, entry.isHoliday && styles.agendaHoliday,
              )}
              data-day={day}
              onClick={handleDayClick}
            >
              {formatDayLong(lang, day)}
            </button>
            {entry.events.map((event) => (
              <button
                key={`e${instanceKey(event)}`}
                type="button"
                className={styles.agendaRow}
                data-kind="event"
                data-id={event.id}
                data-day={day}
                onClick={handleRowClick}
              >
                <span className={styles.agendaTime}>
                  {event.isAllDay ? lang('PlannerAllDay') : `${event.start}–${event.end}`}
                </span>
                <span className={styles.agendaName}>{event.name}</span>
              </button>
            ))}
            {entry.tasks.map((task) => (
              <button
                key={`t${instanceKey(task)}`}
                type="button"
                className={buildClassName(styles.agendaRow, task.status === 'done' && styles.agendaDone)}
                style={listColorStyle(getListColor(state, task.project))}
                data-kind="task"
                data-id={task.id}
                data-day={day}
                onClick={handleRowClick}
              >
                <span className={styles.agendaTime}>{task.start || lang('PlannerAgendaNoTime')}</span>
                <span className={styles.agendaName}>{task.name}</span>
              </button>
            ))}
            {entry.deadlines.map((task) => (
              <button
                key={`d${task.id}`}
                type="button"
                className={buildClassName(styles.agendaRow, styles.agendaDue)}
                style={listColorStyle(getListColor(state, task.project))}
                data-kind="task"
                data-id={task.id}
                onClick={handleRowClick}
              >
                <span className={styles.agendaTime}>{lang('PlannerAgendaDue')}</span>
                <span className={styles.agendaName}>{task.name}</span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
};

export default memo(PlannerAgenda);
