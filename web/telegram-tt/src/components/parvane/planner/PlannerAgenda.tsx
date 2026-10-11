import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDayLong, listColorStyle } from './plannerFormat';
import {
  addDays, AGENDA_DAYS, buildDayIndex, getListColor, instanceKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerTaskRow from './PlannerTaskRow';

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

// Вид «Список» (spec 018): повестка на 30 дней от выбранного дня, пустые дни пропущены
const PlannerAgenda = ({
  state, day, today, onPickDay, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const days = useMemo(() => {
    const lastDay = addDays(day, AGENDA_DAYS - 1);
    const index = buildDayIndex(state, day, lastDay);
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

  return (
    <div className={styles.agenda} data-planner-view="agenda">
      {!days.length && <p className={styles.small}>{lang('PlannerAgendaEmpty')}</p>}
      {days.map(([key, entry]) => (
        <section key={key} className={styles.agendaDay} data-day={key}>
          <button
            type="button"
            className={buildClassName(
              styles.agendaDayTitle, key === today && styles.agendaDayToday, entry.isHoliday && styles.agendaHoliday,
            )}
            data-day={key}
            onClick={handleDayClick}
          >
            {formatDayLong(lang, key)}
          </button>
          {entry.events.map((event) => (
            <button
              key={event.id}
              type="button"
              className={styles.agendaRow}
              style={listColorStyle(event.color)}
              data-event-id={event.id}
              data-day={key}
              onClick={handleEventClick}
            >
              <span className={styles.agendaTime}>
                {event.isAllDay ? lang('PlannerAllDayShort') : `${event.start}–${event.end}`}
              </span>
              <span className={styles.agendaName}>{event.name}</span>
            </button>
          ))}
          {[...entry.tasks]
            .sort((a, b) => (a.start || '99').localeCompare(b.start || '99'))
            .map((task) => (
              <PlannerTaskRow
                key={instanceKey(task)}
                task={task}
                context="day"
                color={getListColor(state, task.project)}
                onOpen={onOpenTask}
              />
            ))}
          {entry.deadlines.map((task) => (
            <PlannerTaskRow
              key={`due-${task.id}`}
              task={task}
              context="all"
              color={getListColor(state, task.project)}
              onOpen={onOpenTask}
            />
          ))}
        </section>
      ))}
    </div>
  );
};

export default memo(PlannerAgenda);
