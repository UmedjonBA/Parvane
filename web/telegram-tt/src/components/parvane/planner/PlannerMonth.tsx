import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerDayIndexEntry, PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatHours, formatSpan, formatWeekday, listColorStyle,
} from './plannerFormat';
import { getDailyRecord, getDayBudget, isShortSleep } from './plannerHealth';
import { formatPlainName } from './plannerLinks';
import {
  fromDayKey, getDayRange, getEventColor, getListColor, getMonthGridKeys, instanceKey, toDayKey,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import { TASK_DRAG_TYPE } from './PlannerTaskRow';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  month: Date;
  picked: string;
  today: string;
  layers: PlannerLayers;
  onPickDay: (day: string) => void;
  onCreateForDay: (day: string) => void;
  onOpenTask: (taskId: string, day: string) => void;
  // `taskKey` — id задачи либо `id@день` экземпляра ряда
  onMoveTask: (taskKey: string, day: string) => void;
};

type Entry = {
  key: string;
  // `id` задачи либо `id@день` экземпляра ряда; у события нет
  taskId?: string;
  label: string;
  kind: 'event' | 'task' | 'due';
  color: number;
  order: string;
};

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];
const PREVIEW_COUNT = 2;
const DOT_COUNT = 4;
const KIND_CLASSES = {
  event: styles.kindEvent,
  task: styles.kindTask,
  due: styles.kindDue,
};
const EMPTY_ENTRY: PlannerDayIndexEntry = {
  tasks: [], events: [], deadlines: [], isHoliday: false, minutes: 0, timed: [], untimed: [], allDay: [],
  conflicts: 0, unrated: 0,
};

// Месяц: в клетке — число, занятые часы, сон и первые дела дня с точкой цвета записи; на телефоне — число
// и точки. Праздник заливает клетку
const PlannerMonth = ({
  state, month, picked, today, layers, onPickDay, onCreateForDay, onOpenTask, onMoveTask,
}: OwnProps) => {
  const lang = useLang();

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const taskKey = target.closest<HTMLElement>('[data-preview-task]')?.dataset.previewTask;
    const day = e.currentTarget.dataset.day!;
    if (taskKey) onOpenTask(taskKey.split('@')[0], day);
    else onPickDay(day);
  });

  const handleDayDoubleClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-preview-task]')) return;
    onCreateForDay(e.currentTarget.dataset.day!);
  });

  const handleDragOver = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  const handleDrop = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    const taskId = e.dataTransfer.getData(TASK_DRAG_TYPE);
    if (!taskId) return;
    e.preventDefault();
    onMoveTask(taskId, e.currentTarget.dataset.day!);
  });

  const handlePreviewDragStart = useLastCallback((e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(TASK_DRAG_TYPE, e.currentTarget.dataset.previewTask!);
    e.dataTransfer.effectAllowed = 'move';
  });

  // Полные недели: дни соседних месяцев показаны бледнее, нажатие переходит к ним. Дела всех клеток — из
  // индекса дней (один проход по записям на сетку), пересчёт только при смене состояния, месяца либо слоёв
  const days = useMemo(() => getMonthGridKeys(month), [month]);
  const monthPrefix = toDayKey(month).slice(0, 7);
  const cells = useMemo(() => {
    const index = getDayRange(state, days[0], days[days.length - 1]);
    return days.map((day) => {
      const entry = index.get(day) || EMPTY_ENTRY;
      const { events } = entry;
      const sleep = layers.sleep ? getDailyRecord(state, 'sleep', day) : undefined;
      // События на весь день — первыми, дальше дела по времени начала, сроки — в конце
      const dayItems: Entry[] = [
        ...events.map((event): Entry => ({
          key: `event${instanceKey(event)}`,
          label: formatPlainName(event.name),
          kind: event.isHoliday && !getEventColor(state, event) ? 'due' : 'event',
          color: getEventColor(state, event),
          order: event.isAllDay ? '' : event.start,
        })),
        ...entry.tasks.map((task): Entry => ({
          key: `task${instanceKey(task)}`,
          taskId: instanceKey(task),
          label: formatPlainName(task.name),
          kind: 'task',
          color: getListColor(state, task.project),
          order: task.start || '00:00',
        })),
      ].sort((a, b) => a.order.localeCompare(b.order));
      const dueItems = entry.deadlines.map((task): Entry => ({
        key: `due${task.id}`,
        taskId: task.id,
        label: lang('PlannerDeadlinePreview', { name: formatPlainName(task.name) }),
        kind: 'due',
        color: 0,
        order: '',
      }));
      const entries = layers.work ? [...dayItems, ...dueItems] : [];
      // Точки (телефон): по одной на цвет записи, недосып — красная
      const dots = [...new Map(entries.map((item) => [`${item.kind}${item.color}`, item])).values()]
        .slice(0, DOT_COUNT);
      return {
        day,
        minutes: entry.minutes,
        unrated: entry.unrated,
        conflicts: entry.conflicts,
        budget: getDayBudget(state, day),
        sleep,
        isShort: isShortSleep(state, day),
        holiday: entry.holiday,
        allDayCount: entry.allDay.length,
        entries,
        dots,
      };
    });
  }, [state, days, layers, lang]);

  return (
    <div className={styles.month} role="grid">
      {WEEKDAY_INDEXES.map((index) => (
        <span key={`weekday${index}`} className={styles.monthWeekday}>{formatWeekday(lang, index)}</span>
      ))}
      {cells.map(({
        day, minutes, unrated, conflicts, budget, sleep, isShort, holiday, allDayCount, entries, dots,
      }) => {
        return (
          <div
            key={day}
            className={buildClassName(
              styles.monthCell,
              day === today && styles.monthCellToday,
              day === picked && styles.monthCellPicked,
              holiday && styles.monthCellHoliday,
              !day.startsWith(monthPrefix) && styles.monthCellOutside,
            )}
            style={holiday?.color ? `--planner-holiday-color: var(--color-peer-${holiday.color - 1})` : undefined}
            data-day={day}
            data-holiday={holiday ? '1' : undefined}
            role="gridcell"
            aria-selected={day === picked}
            aria-label={lang('PlannerAriaDay', {
              date: formatDay(lang, day), hours: formatHours(lang, minutes), unrated, conflicts,
            })}
            onClick={handleDayClick}
            onDoubleClick={handleDayDoubleClick}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <span className={styles.monthHead}>
              <span className={styles.monthNumber}>{fromDayKey(day).getDate()}</span>
              {Boolean(minutes) && (
                <span className={buildClassName(styles.monthHours, minutes > budget && styles.red)}>
                  {conflicts ? '! ' : ''}
                  {formatHours(lang, minutes)}
                </span>
              )}
            </span>
            {sleep && (
              <span
                className={buildClassName(
                  styles.monthItem, styles.monthSleep, isShort ? styles.kindDue : styles.kindSleep,
                )}
              >
                {lang('PlannerMonthSleep', { value: formatSpan(sleep.value) })}
              </span>
            )}
            {entries.slice(0, PREVIEW_COUNT).map((entry) => (entry.taskId !== undefined ? (
              <button
                key={entry.key}
                type="button"
                className={buildClassName(styles.monthItem, styles.monthItemButton, KIND_CLASSES[entry.kind])}
                style={listColorStyle(entry.color)}
                title={entry.label}
                draggable
                data-preview-task={entry.taskId}
                onDragStart={handlePreviewDragStart}
              >
                {entry.label}
              </button>
            ) : (
              <span
                key={entry.key}
                className={buildClassName(styles.monthItem, KIND_CLASSES[entry.kind])}
                style={listColorStyle(entry.color)}
                title={entry.label}
              >
                {entry.label}
              </span>
            )))}
            {entries.length > PREVIEW_COUNT && (
              <span className={buildClassName(styles.monthItem, styles.monthMore)}>
                {`+${entries.length - PREVIEW_COUNT}`}
              </span>
            )}
            <span className={styles.monthDots} data-all-day-marks={allDayCount || undefined}>
              {dots.map((entry) => (
                <span
                  key={entry.key}
                  className={buildClassName(styles.monthDot, KIND_CLASSES[entry.kind])}
                  style={listColorStyle(entry.color)}
                />
              ))}
              {sleep && isShort && <span className={buildClassName(styles.monthDot, styles.kindDue)} />}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default memo(PlannerMonth);
