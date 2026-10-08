import { memo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatHours, formatWeekday } from './plannerFormat';
import {
  countConflicts, countUnrated, fromDayKey, getDayLoad, getDeadlines, getEventsForDay, getLoadFraction,
  getMonthKeys, getMonthOffset, getTasksForDay, instanceKey,
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
  onPickDay: (day: string) => void;
  onCreateForDay: (day: string) => void;
  onOpenTask: (taskId: string, day: string) => void;
  // `taskKey` — id задачи либо `id@день` экземпляра ряда
  onMoveTask: (taskKey: string, day: string) => void;
};

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];
const PREVIEW_COUNT = 2;
// Оттенок HSL: 140 — зелёный (день свободен), 0 — красный (бюджет исчерпан)
const FREE_DAY_HUE = 140;

function getLoadHue(fraction: number) {
  return Math.round(FREE_DAY_HUE * (1 - fraction));
}

const PlannerMonth = ({
  state, month, picked, today, onPickDay, onCreateForDay, onOpenTask, onMoveTask,
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

  const offset = getMonthOffset(month);
  const days = getMonthKeys(month);
  const trailing = (7 - ((offset + days.length) % 7)) % 7;

  return (
    <div className={styles.month} role="grid">
      {WEEKDAY_INDEXES.map((index) => (
        <span key={`weekday${index}`} className={styles.weekday}>{formatWeekday(lang, index)}</span>
      ))}
      {Array.from({ length: offset }, (_, i) => <span key={`before${i}`} className={styles.blank} />)}
      {days.map((day) => {
        const minutes = getDayLoad(state, day);
        const deadlines = getDeadlines(state, day);
        const unrated = countUnrated(state, day);
        const conflicts = countConflicts(state, day);
        const fraction = getLoadFraction(state, minutes);
        const entries = [
          ...deadlines.map((task) => ({
            key: `due${task.id}`,
            taskId: task.id,
            label: lang('PlannerDeadlinePreview', { name: task.name }),
            isDue: true,
          })),
          ...getTasksForDay(state, day).filter((task) => !deadlines.includes(task)).map((task) => ({
            key: `task${instanceKey(task)}`,
            taskId: instanceKey(task),
            label: `${task.start ? `${task.start} ` : ''}${task.name}`,
            isDue: false,
          })),
          ...getEventsForDay(state, day).map((event) => ({
            key: `event${instanceKey(event)}`, taskId: undefined, label: `${event.start} ${event.name}`, isDue: false,
          })),
        ];
        const weekday = fromDayKey(day).getDay();

        return (
          <div
            key={day}
            className={buildClassName(
              styles.day,
              day === today && styles.dayToday,
              day === picked && styles.daySelected,
              (weekday === 0 || weekday === 6) && styles.dayWeekend,
            )}
            style={`--planner-load: ${Math.round(fraction * 100)}%; --planner-load-hue: ${getLoadHue(fraction)}`}
            data-day={day}
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
            <span className={styles.dayHead}>
              <span className={styles.dayNumber}>{fromDayKey(day).getDate()}</span>
              <span className={styles.dayHours}>
                {conflicts ? '! ' : ''}
                {formatHours(lang, minutes)}
              </span>
            </span>
            {entries.slice(0, PREVIEW_COUNT).map((entry) => (entry.taskId !== undefined ? (
              <button
                key={entry.key}
                type="button"
                className={buildClassName(styles.preview, styles.previewTask, entry.isDue && styles.previewDue)}
                title={entry.label}
                draggable
                data-preview-task={entry.taskId}
                onDragStart={handlePreviewDragStart}
              >
                {entry.label}
              </button>
            ) : (
              <span key={entry.key} className={styles.preview} title={entry.label}>{entry.label}</span>
            )))}
            {entries.length > PREVIEW_COUNT && (
              <span className={buildClassName(styles.small, styles.previewMore)}>
                {lang('PlannerMore', { count: entries.length - PREVIEW_COUNT })}
              </span>
            )}
            {!entries.length && <span className={styles.small}>{lang('PlannerFree')}</span>}
            {Boolean(unrated) && <span className={styles.warning}>{`+${unrated} ?`}</span>}
            <span className={styles.loadBar} aria-hidden="true"><span className={styles.loadFill} /></span>
          </div>
        );
      })}
      {Array.from({ length: trailing }, (_, i) => <span key={`after${i}`} className={styles.blank} />)}
    </div>
  );
};

export default memo(PlannerMonth);
