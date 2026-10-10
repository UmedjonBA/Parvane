import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, listColorStyle } from './plannerFormat';
import {
  getDeadlines, getEventsForDay, getListColor, getTasksForDay, getTimedForDay, instanceKey, layoutTimed, setTaskDone,
  toMinutes, toTime,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  // Форма нового дела раскрывается под шкалой
  inlineForm?: TeactNode;
  onAdd: NoneToVoidFunction;
  onCreateAt: (day: string, start: number) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

const MINUTES_IN_HOUR = 60;
// Ширина часа и высота строки шкалы, rem
const HOUR_REM = 5;
const ROW_REM = 2.75;
const MIN_ROWS = 2;
// Короткое дело рисуется не уже этого — иначе название не прочесть
const MIN_BLOCK_MINUTES = 45;
const CREATE_STEP = 30;

// Узкий экран: день — горизонтальной шкалой времени над календарём. Часы идут по оси X, шкала
// листается вбок; пересекающиеся дела стоят в разных строках. Дела без времени, события на весь
// день и дедлайны — плашками над шкалой
const PlannerTimeline = ({
  state, day, inlineForm, onAdd, onCreateAt, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const scrollRef = useRef<HTMLDivElement>();
  const rootRef = useRef<HTMLDivElement>();
  const hasInlineForm = Boolean(inlineForm);

  const timed = getTimedForDay(state, day);
  // Строки считаются по нарисованной ширине: короткое дело шире своей длительности
  const layout = layoutTimed(timed.map((item) => ({
    ...item,
    end: toTime(Math.max(toMinutes(item.end), toMinutes(item.start) + MIN_BLOCK_MINUTES)),
  })));
  const starts = timed.map((item) => toMinutes(item.start));
  const ends = layout.map(({ item }) => toMinutes(item.end));
  const firstHour = Math.floor(Math.min(state.settings.dayStart, ...starts) / MINUTES_IN_HOUR);
  const lastHour = Math.ceil(Math.max(state.settings.dayEnd, ...ends) / MINUTES_IN_HOUR);
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const gridStart = firstHour * MINUTES_IN_HOUR;
  const rows = Math.max(MIN_ROWS, ...layout.map(({ lane }) => lane + 1));
  // Шкала открывается на первом деле дня, а без дел — на начале дня из настроек
  const focusHour = Math.floor((starts.length ? Math.min(...starts) : state.settings.dayStart) / MINUTES_IN_HOUR);

  const allDay = getEventsForDay(state, day).filter((event) => event.isAllDay);
  const untimed = getTasksForDay(state, day).filter((task) => !task.start || task.minutes === undefined);
  const deadlines = getDeadlines(state, day);

  useEffect(() => {
    scrollRef.current?.querySelector(`[data-hour="${focusHour}"]`)
      ?.scrollIntoView({ inline: 'start', block: 'nearest' });
  }, [day, focusHour]);

  // Раскрытая форма должна быть на виду
  useEffect(() => {
    if (!hasInlineForm) return;
    rootRef.current?.querySelector('[data-inline-form]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hasInlineForm]);

  const handleTrackClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = gridStart + ((e.clientX - rect.left) / rect.width) * hours.length * MINUTES_IN_HOUR;
    const start = Math.floor(minutes / CREATE_STEP) * CREATE_STEP;
    onCreateAt(day, Math.max(0, Math.min(start, lastHour * MINUTES_IN_HOUR - CREATE_STEP)));
  });

  const handleItemClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day);
    else onOpenTask(id!, day);
  });

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { id } = e.currentTarget.dataset;
    const { checked } = e.currentTarget;
    const task = getTasksForDay(state, day).find((candidate) => candidate.id === id);
    if (!task) return;
    updatePlanner((draft) => {
      setTaskDone(draft, task, checked);
    }, lang(checked ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  return (
    <div ref={rootRef} className={styles.timeline} data-day-timeline={day}>
      <div className={buildClassName(styles.timelineHead, 'no-scrollbar')}>
        <span className={styles.timelineDay}>{formatDay(lang, day)}</span>
        <Button
          round
          size="tiny"
          color="translucent"
          className={styles.panelAdd}
          iconName="add"
          ariaLabel={lang('PlannerAddTaskForDay')}
          onClick={onAdd}
        />
        {allDay.map((event) => (
          <button
            key={`e${instanceKey(event)}`}
            type="button"
            className={buildClassName(styles.weekChip, styles.timelineChip, event.isHoliday && styles.weekChipHoliday)}
            data-kind="event"
            data-all-day={event.id}
            data-holiday={event.isHoliday ? '1' : undefined}
            data-id={event.id}
            onClick={handleItemClick}
          >
            {event.name}
          </button>
        ))}
        {untimed.map((task) => (
          <button
            key={`t${instanceKey(task)}`}
            type="button"
            className={buildClassName(
              styles.weekChip, styles.timelineChip, task.status === 'done' && styles.agendaDone,
            )}
            style={listColorStyle(getListColor(state, task.project))}
            data-kind="task"
            data-id={task.id}
            onClick={handleItemClick}
          >
            {task.name}
          </button>
        ))}
        {deadlines.map((task) => (
          <button
            key={`d${task.id}`}
            type="button"
            className={buildClassName(styles.weekChip, styles.timelineChip, styles.previewDue)}
            data-kind="task"
            data-id={task.id}
            onClick={handleItemClick}
          >
            {lang('PlannerDeadlinePreview', { name: task.name })}
          </button>
        ))}
      </div>
      <div ref={scrollRef} className={buildClassName(styles.timelineScroll, 'no-scrollbar')}>
        <div className={styles.timelineHours} style={`width: ${hours.length * HOUR_REM}rem`}>
          {hours.map((hour) => (
            <span key={hour} className={styles.timelineHour} style={`width: ${HOUR_REM}rem`} data-hour={hour}>
              {toTime(hour * MINUTES_IN_HOUR)}
            </span>
          ))}
        </div>
        <div
          className={styles.timelineTrack}
          style={`width: ${hours.length * HOUR_REM}rem; height: ${rows * ROW_REM}rem; --planner-hour: ${HOUR_REM}rem`}
          onClick={handleTrackClick}
        >
          {layout.map(({ item, lane }) => {
            const start = toMinutes(item.start);
            const left = ((start - gridStart) / MINUTES_IN_HOUR) * HOUR_REM;
            const width = ((toMinutes(item.end) - start) / MINUTES_IN_HOUR) * HOUR_REM;
            const position = `inset-inline-start: ${left}rem; width: ${width}rem; top: ${lane * ROW_REM}rem; `
              + `height: ${ROW_REM}rem`;
            const color = item.task ? listColorStyle(getListColor(state, item.task.project)) : undefined;
            const source = timed.find((candidate) => (
              candidate.task ? candidate.task === item.task : candidate.event === item.event
            ))!;
            const itemKey = item.task ? `t${instanceKey(item.task)}` : `e${instanceKey(item.event!)}`;
            return (
              <div
                key={itemKey}
                className={buildClassName(
                  styles.weekBlock,
                  styles.timelineBlock,
                  item.event && styles.weekBlockEvent,
                  item.task?.status === 'done' && styles.agendaDone,
                )}
                style={color ? `${position}; ${color}` : position}
                data-block={itemKey}
              >
                {item.task && (
                  <input
                    type="checkbox"
                    className={styles.weekBlockCheck}
                    checked={item.task.status === 'done'}
                    aria-label={lang('PlannerAriaDone', { name: item.task.name })}
                    data-id={item.task.id}
                    onChange={handleToggle}
                  />
                )}
                <button
                  type="button"
                  className={styles.weekBlockOpen}
                  title={`${source.start}–${source.end} ${item.name}`}
                  data-kind={item.task ? 'task' : 'event'}
                  data-id={item.task ? item.task.id : item.event!.id}
                  onClick={handleItemClick}
                >
                  <span className={styles.weekBlockName}>{item.name}</span>
                  <span className={styles.weekBlockTime}>{`${source.start}–${source.end}`}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {Boolean(inlineForm) && <div className={styles.inlineForm} data-inline-form>{inlineForm}</div>}
    </div>
  );
};

export default memo(PlannerTimeline);
