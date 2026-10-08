import { memo } from '../../../lib/teact/teact';

import type { PlannerEvent, PlannerSlot, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatClock, formatDuration, formatHours, formatWeekday,
} from './plannerFormat';
import {
  countUnrated, getDayAvailability, getDayLoad, getDeadlines, getTasksForDay, toTime,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import PlannerTaskRow from './PlannerTaskRow';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  onOpenTask: (taskId: number) => void;
  onCreateTask: (slot?: PlannerSlot) => void;
};

// Расписание дня: свободные окна 09–21 и занятые отрезки, дела без времени, дедлайны
const PlannerDay = ({
  state, day, onOpenTask, onCreateTask,
}: OwnProps) => {
  const lang = useLang();

  const handleFreeClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onCreateTask({ start: Number(e.currentTarget.dataset.start), end: Number(e.currentTarget.dataset.end) });
  });

  const handleAdd = useLastCallback(() => {
    onCreateTask();
  });

  const handleDeleteEvent = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const eventId = Number(e.currentTarget.dataset.eventId);
    updatePlanner((draft) => {
      draft.events = draft.events.filter(({ id }) => id !== eventId);
    }, lang('PlannerNoticeEventDeleted'));
  });

  const minutes = getDayLoad(state, day);
  const unrated = countUnrated(state, day);
  const availability = getDayAvailability(state, day);
  const isOver = minutes > state.budget;
  const chunks = [
    ...availability.free.map((slot) => ({ ...slot, items: undefined })),
    ...availability.groups,
  ].sort((a, b) => a.start - b.start);
  const untimed = getTasksForDay(state, day).filter((task) => !task.start || task.minutes === undefined);
  const deadlines = getDeadlines(state, day);

  const summary = [
    lang('PlannerDayPlan', { planned: formatHours(lang, minutes), budget: formatHours(lang, state.budget) }),
    isOver ? lang('PlannerDayOverload', { minutes: minutes - state.budget }) : undefined,
    lang('PlannerDayWindows', {
      from: formatClock(state.settings.dayStart),
      to: formatClock(state.settings.dayEnd),
      free: formatDuration(lang, availability.freeMinutes),
    }),
    unrated ? lang('PlannerDayUnrated', { count: unrated }) : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <div className={styles.dayList}>
      <p className={buildClassName(styles.summary, isOver && styles.warning)}>{summary}</p>
      {chunks.map((chunk) => (chunk.items ? (
        <section
          key={`busy${chunk.start}`}
          className={buildClassName(styles.busy, chunk.items.length > 1 && styles.busyCollision)}
        >
          {chunk.items.map((item) => (
            <div key={item.task ? `task${item.task.id}` : `event${item.event!.id}`} className={styles.busyRow}>
              <span className={styles.clock}>{`${item.start}–${item.end}`}</span>
              {item.task ? (
                <PlannerTaskRow task={item.task} context="day" onOpen={onOpenTask} />
              ) : (
                <div className={styles.eventBody}>
                  <span className={styles.taskName}>{item.name}</span>
                  <span className={styles.small}>{formatEventRepeat(item.event!)}</span>
                  <Button
                    round
                    size="tiny"
                    color="translucent"
                    className={styles.eventDelete}
                    iconName="delete"
                    ariaLabel={lang('PlannerAriaDeleteEvent', { name: item.name })}
                    data-event-id={item.event!.id}
                    onClick={handleDeleteEvent}
                  />
                </div>
              )}
            </div>
          ))}
          {chunk.items.length > 1 && <div className={styles.warning}>{lang('PlannerTimeConflict')}</div>}
        </section>
      ) : (
        <button
          key={`free${chunk.start}`}
          type="button"
          className={styles.free}
          data-start={chunk.start}
          data-end={chunk.end}
          aria-label={lang('PlannerAriaFreeSlot', { from: toTime(chunk.start), to: toTime(chunk.end) })}
          onClick={handleFreeClick}
        >
          <span className={styles.clock}>{`${toTime(chunk.start)}–${toTime(chunk.end)}`}</span>
          <span className={styles.freeBody}>
            <span>{lang('PlannerFree')}</span>
            <span className={styles.small}>{`${formatDuration(lang, chunk.end - chunk.start)} · +`}</span>
          </span>
        </button>
      )))}
      {Boolean(untimed.length) && <h3 className={styles.group}>{lang('PlannerGroupUntimed')}</h3>}
      {untimed.map((task) => <PlannerTaskRow key={task.id} task={task} context="day" onOpen={onOpenTask} />)}
      {Boolean(deadlines.length) && <h3 className={styles.group}>{lang('PlannerGroupDeadlines')}</h3>}
      {deadlines.map((task) => <PlannerTaskRow key={`due${task.id}`} task={task} context="day" onOpen={onOpenTask} />)}
      <Button isText size="smaller" className={styles.inlineAdd} onClick={handleAdd}>
        {lang('PlannerAddTaskForDay')}
      </Button>
    </div>
  );

  function formatEventRepeat(event: PlannerEvent) {
    if (event.day) return lang('PlannerEventOnce');
    // `weekdays` — как `Date.getDay`; подписи — с понедельника
    const names = [...event.weekdays!].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      .map((weekday) => formatWeekday(lang, (weekday + 6) % 7));
    return lang('PlannerEventRepeats', { days: names.join(', ') });
  }
};

export default memo(PlannerDay);
