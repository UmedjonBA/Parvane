import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayLong, formatWeekday, formatWeekNumber, formatWeekRange, listColorStyle,
} from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import {
  fromDayKey, getDayRange, getEventColor, getListColor, instanceKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerName from './PlannerName';

import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  // Семь дней недели выбранного дня
  days: string[];
  picked: string;
  today: string;
  onOpenDay: (day: string) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

const PERCENT = 100;

// Неделя на телефоне (доска `XpPlan`): семь дней строками — дела дня и полоса загрузки; нажатие на число
// открывает день
const PlannerWeekList = ({
  state, days, picked, today, onOpenDay, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const rows = useMemo(() => {
    const index = getDayRange(state, days[0], days[days.length - 1]);
    return days.map((day) => {
      const entry = index.get(day);
      const budget = getDayBudget(state, day);
      const minutes = entry?.minutes || 0;
      return {
        day,
        events: entry ? entry.events : [],
        tasks: entry ? entry.tasks : [],
        share: budget ? Math.min(1, minutes / budget) * PERCENT : 0,
        isOver: minutes > budget,
      };
    });
  }, [state, days]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenDay(e.currentTarget.dataset.day!);
  });

  const handleItemClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id, day } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day!);
    else onOpenTask(id!, day);
  });

  return (
    <div className={pv.weekList} data-planner-view="week">
      <h3 className={pv.cap}>
        {lang('PlannerWeekTitle', { range: formatWeekRange(lang, picked), week: formatWeekNumber(picked) })}
      </h3>
      {rows.map(({
        day, events, tasks, share, isOver,
      }) => (
        <div
          key={day}
          className={buildClassName(pv.weekRow, day === picked && pv.weekRowPicked)}
          data-week-day={day}
        >
          <button
            type="button"
            className={buildClassName(pv.weekDate, day === today && pv.weekDateToday)}
            aria-label={formatDayLong(lang, day)}
            data-day={day}
            onClick={handleDayClick}
          >
            <span className={pv.weekDateName}>{formatWeekday(lang, (fromDayKey(day).getDay() + 6) % 7)}</span>
            <span className={pv.weekDateNumber}>{fromDayKey(day).getDate()}</span>
          </button>
          <div className={pv.weekItems}>
            {!events.length && !tasks.length && <span className={pv.weekFree}>{lang('PlannerFree')}</span>}
            {[
              ...events.map((event) => ({
                order: event.isAllDay ? '' : event.start,
                node: (
                  <button
                    key={`e${instanceKey(event)}`}
                    type="button"
                    className={buildClassName(pv.weekItem, event.isHoliday ? styles.kindDue : styles.kindEvent)}
                    style={listColorStyle(getEventColor(state, event))}
                    data-kind="event"
                    data-id={event.id}
                    data-day={day}
                    onClick={handleItemClick}
                  >
                    <span className={pv.weekItemTime}>{event.isAllDay ? lang('PlannerAllDayTiny') : event.start}</span>
                    <span className={pv.weekItemName}><PlannerName name={event.name} /></span>
                  </button>
                ),
              })),
              ...tasks.map((task) => ({
                order: task.start || '99',
                node: (
                  <button
                    key={`t${instanceKey(task)}`}
                    type="button"
                    className={buildClassName(
                      pv.weekItem, styles.kindTask, task.status === 'done' && pv.weekItemDone,
                    )}
                    style={listColorStyle(getListColor(state, task.project))}
                    data-kind="task"
                    data-id={task.id}
                    data-day={task.instanceDay}
                    onClick={handleItemClick}
                  >
                    <span className={pv.weekItemTime}>{task.start || '—'}</span>
                    <span className={pv.weekItemName}><PlannerName name={task.name} /></span>
                  </button>
                ),
              })),
            ].sort((x, y) => x.order.localeCompare(y.order)).map(({ node }) => node)}
            <span className={buildClassName(pv.loadBar, pv.weekBar)} aria-hidden>
              <span className={buildClassName(pv.loadFill, isOver && pv.loadFillOver)} style={`width: ${share}%`} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default memo(PlannerWeekList);
