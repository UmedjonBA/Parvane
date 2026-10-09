import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import type { PlannerEvent, PlannerSlot, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatClock, formatDuration, formatHours, formatRepeat,
} from './plannerFormat';
import {
  countUnrated, excludeInstance, getDayAvailability, getDayLoad, getDeadlines, getEventsForDay, getListColor,
  getTasksForDay,
  instanceKey, toTime,
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
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  onCreateTask: (slot?: PlannerSlot) => void;
  // Узкий экран: форма новой задачи раскрывается прямо в расписании — на месте свободного окна
  // с началом `inlineFormStart` либо в конце списка
  inlineForm?: TeactNode;
  inlineFormStart?: number;
  // Узкий экран: расписание — горизонтальная лента под календарём, листается вбок; форма новой
  // задачи раскрывается под лентой
  isStrip?: boolean;
};

// Расписание дня: свободные окна 09–21 и занятые отрезки, дела без времени, дедлайны
const PlannerDay = ({
  state, day, inlineForm, inlineFormStart, isStrip, onOpenTask, onOpenEvent, onCreateTask,
}: OwnProps) => {
  const lang = useLang();

  const rootRef = useRef<HTMLDivElement>();
  const hasInlineForm = Boolean(inlineForm);

  // Раскрытая форма должна быть на виду: свободное окно могло стоять у нижнего края экрана
  useEffect(() => {
    if (!hasInlineForm) return;
    rootRef.current?.querySelector('[data-inline-form]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hasInlineForm, inlineFormStart]);

  const handleFreeClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onCreateTask({ start: Number(e.currentTarget.dataset.start), end: Number(e.currentTarget.dataset.end) });
  });

  const handleAdd = useLastCallback(() => {
    onCreateTask();
  });

  // Экземпляр ряда удаляется только в этот день («только это»); весь ряд — из редактора события
  const handleDeleteEvent = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const eventId = e.currentTarget.dataset.eventId!;
    updatePlanner((draft) => {
      const target = draft.events.find(({ id }) => id === eventId);
      if (target?.repeat) excludeInstance(draft, 'event', eventId, day);
      else draft.events = draft.events.filter(({ id }) => id !== eventId);
    }, lang('PlannerNoticeEventDeleted'));
  });

  const handleOpenEvent = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenEvent(e.currentTarget.dataset.eventId!, day);
  });

  const minutes = getDayLoad(state, day);
  const unrated = countUnrated(state, day);
  const availability = getDayAvailability(state, day);
  const isOver = minutes > state.budget;
  const chunks = [
    ...availability.free.map((slot) => ({ ...slot, items: undefined })),
    ...availability.groups,
  ].sort((a, b) => a.start - b.start);
  // События на весь день — отдельной строкой сверху: в окна и загрузку дня они не входят
  const allDay = getEventsForDay(state, day).filter((event) => event.isAllDay);
  // Узкий экран: задача добавляется нажатием на свободное окно — отдельная кнопка нужна, только
  // когда свободных окон в дне нет
  const hasFreeSlot = chunks.some((chunk) => !chunk.items);
  const hasInlineSlot = Boolean(inlineForm) && chunks.some((chunk) => !chunk.items && chunk.start === inlineFormStart);
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
    <div ref={rootRef} className={styles.dayList}>
      {!isStrip && <p className={buildClassName(styles.summary, isOver && styles.warning)}>{summary}</p>}
      <div
        className={buildClassName(styles.dayItems, isStrip && styles.dayStrip, isStrip && 'no-scrollbar')}
        data-day-strip={isStrip ? '1' : undefined}
      >
        {allDay.map((event) => (
          <div key={`allday${instanceKey(event)}`} className={styles.busyRow} data-all-day={event.id}>
            <span className={styles.clock}>{lang('PlannerAllDayShort')}</span>
            {renderEvent(event)}
          </div>
        ))}
        {chunks.map((chunk) => (chunk.items ? (
          <section
            key={`busy${chunk.start}`}
            className={buildClassName(styles.busy, chunk.items.length > 1 && styles.busyCollision)}
          >
            {chunk.items.map((item) => (
              <div
                key={item.task ? `task${instanceKey(item.task)}` : `event${instanceKey(item.event!)}`}
                className={styles.busyRow}
              >
                <span className={styles.clock}>{`${item.start}–${item.end}`}</span>
                {item.task ? (
                  <PlannerTaskRow
                    task={item.task}
                    context="day"
                    color={getListColor(state, item.task.project)}
                    onOpen={onOpenTask}
                  />
                ) : renderEvent(item.event!)}
              </div>
            ))}
            {chunk.items.length > 1 && <div className={styles.warning}>{lang('PlannerTimeConflict')}</div>}
          </section>
        ) : inlineForm && !isStrip && chunk.start === inlineFormStart ? (
          <div key={`form${chunk.start}`} className={styles.inlineForm} data-inline-form>
            {inlineForm}
          </div>
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
        {untimed.map((task) => (
          <PlannerTaskRow
            key={instanceKey(task)}
            task={task}
            context="day"
            color={getListColor(state, task.project)}
            onOpen={onOpenTask}
          />
        ))}
        {Boolean(deadlines.length) && <h3 className={styles.group}>{lang('PlannerGroupDeadlines')}</h3>}
        {deadlines.map((task) => (
          <PlannerTaskRow key={`due${task.id}`} task={task} context="day" onOpen={onOpenTask} />
        ))}
        {(isStrip ? !hasFreeSlot : (!inlineForm || hasInlineSlot)) && (
          <Button isText size="smaller" className={styles.inlineAdd} onClick={handleAdd}>
            {lang('PlannerAddTaskForDay')}
          </Button>
        )}
      </div>
      {Boolean(inlineForm) && (isStrip || !hasInlineSlot) && (
        <div className={styles.inlineForm} data-inline-form>{inlineForm}</div>
      )}
    </div>
  );

  function formatEventRepeat(event: PlannerEvent) {
    return event.repeat ? formatRepeat(lang, event.repeat) : lang('PlannerEventOnce');
  }

  function renderEvent(event: PlannerEvent) {
    const details = [event.isHoliday ? lang('PlannerHoliday') : undefined, formatEventRepeat(event)].filter(Boolean);
    return (
      <div className={styles.eventBody}>
        <button
          type="button"
          className={styles.taskButton}
          data-event-id={event.id}
          aria-label={lang('PlannerAriaEditEvent', { name: event.name })}
          onClick={handleOpenEvent}
        >
          <span className={styles.taskName}>{event.name}</span>
          <span className={styles.small}>{details.join(' · ')}</span>
        </button>
        <Button
          round
          size="tiny"
          color="translucent"
          className={styles.eventDelete}
          iconName="delete"
          ariaLabel={lang('PlannerAriaDeleteEvent', { name: event.name })}
          data-event-id={event.id}
          onClick={handleDeleteEvent}
        />
      </div>
    );
  }
};

export default memo(PlannerDay);
