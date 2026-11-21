import { memo, useMemo } from '../../../lib/teact/teact';

import type { PlannerDayIndexEntry, PlannerState, PlannerTask } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatDuration, joinCaption, listColorStyle } from './plannerFormat';
import { formatDescriptionLine } from './plannerLinks';
import {
  getEventColor, getListColor, instanceKey, setTaskDone, toMinutes,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerName from './PlannerName';
import { TASK_DRAG_TYPE } from './PlannerTaskRow';
import PlannerUnsentMark from './PlannerUnsentMark';

import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  entry: PlannerDayIndexEntry;
  // `rail` — левая колонка компьютера (`DeskPlan`): галочка слева, под названием «10:00 · 1 ч» либо
  // «без времени · 30 мин»; `list` — день под месяцем на телефоне (`PhPlanMore`): время слева, длительность справа
  variant: 'rail' | 'list';
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

type Item = {
  key: string;
  kind: 'task' | 'event';
  id: string;
  name: string;
  start?: string;
  minutes?: number;
  isAllDay?: boolean;
  isHoliday?: boolean;
  color?: number;
  // Первая строка описания (колонка компьютера)
  note?: string;
  task?: PlannerTask;
};

// Дела дня одним списком: по времени, события на весь день первыми, задачи без времени — в конце
const PlannerDayList = ({
  state, day, entry, variant, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const items = useMemo(() => {
    const allDay: Item[] = entry.allDay.map((event) => ({
      key: `a${instanceKey(event)}`,
      kind: 'event',
      id: event.id,
      name: event.name,
      isAllDay: true,
      isHoliday: event.isHoliday,
      color: getEventColor(state, event),
      note: formatDescriptionLine(event.description),
    }));
    const timed: Item[] = entry.timed.map((item) => ({
      key: item.task ? `t${instanceKey(item.task)}` : `e${instanceKey(item.event!)}`,
      kind: item.task ? 'task' : 'event',
      id: item.task ? item.task.id : item.event!.id,
      name: item.name,
      start: item.start,
      minutes: toMinutes(item.end) - toMinutes(item.start),
      color: item.task ? getListColor(state, item.task.project) : getEventColor(state, item.event!),
      note: formatDescriptionLine(item.task ? item.task.description : item.event!.description),
      task: item.task,
    }));
    const untimed: Item[] = entry.untimed.map((task) => ({
      key: `u${instanceKey(task)}`,
      kind: 'task',
      id: task.id,
      name: task.name,
      minutes: task.minutes,
      color: getListColor(state, task.project),
      note: formatDescriptionLine(task.description),
      task,
    }));
    return [...allDay, ...timed, ...untimed];
  }, [state, entry]);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id, instanceDay } = e.currentTarget.dataset;
    if (kind === 'event') onOpenEvent(id!, day);
    else onOpenTask(id!, instanceDay || day);
  });

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { key } = e.currentTarget.dataset;
    const { checked } = e.currentTarget;
    const task = items.find((item) => item.key === key)?.task;
    if (!task) return;
    updatePlanner((draft) => {
      setTaskDone(draft, task, checked);
    }, lang(checked ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  const handleDragStart = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_TYPE, e.currentTarget.dataset.dragKey!);
    e.dataTransfer.effectAllowed = 'move';
  });

  if (!items.length) return <p className={pv.dayEmpty}>{lang('PlannerFree')}</p>;

  const isRail = variant === 'rail';
  const timeOf = (item: Item) => (item.isAllDay ? lang('PlannerAllDayTiny') : item.start);

  return (
    <div className={isRail ? styles.rowsPlain : pv.dayListRows} data-day-list={day}>
      {items.map((item) => {
        const isDone = item.task?.status === 'done';
        const duration = item.minutes ? formatDuration(lang, item.minutes) : undefined;
        return (
          <div
            key={item.key}
            className={buildClassName(
              isRail ? styles.row : pv.dayListRow, isRail && styles.rowCheckStart, isDone && styles.rowDone,
            )}
            style={listColorStyle(item.color)}
            draggable={Boolean(item.task)}
            data-day-row={item.kind}
            data-block={item.key}
            data-all-day={item.isAllDay ? item.id : undefined}
            data-holiday={item.isHoliday ? '1' : undefined}
            data-task-id={item.task?.id}
            data-instance-day={item.task?.instanceDay}
            data-drag-key={item.task ? instanceKey(item.task) : undefined}
            onDragStart={item.task ? handleDragStart : undefined}
          >
            {isRail && (item.task ? (
              <input
                type="checkbox"
                className={styles.check}
                checked={isDone}
                aria-label={lang('PlannerAriaDone', { name: item.name })}
                data-key={item.key}
                onChange={handleToggle}
              />
            ) : <span className={pv.dayListDot} aria-hidden />)}
            {!isRail && <span className={pv.dayListTime}>{timeOf(item) || '—'}</span>}
            <button
              type="button"
              className={isRail ? styles.rowBody : pv.dayListName}
              data-kind={item.kind}
              data-id={item.id}
              data-instance-day={item.task?.instanceDay}
              onClick={handleOpen}
            >
              <span className={isRail ? styles.rowTitle : pv.dayListTitle}><PlannerName name={item.name} /></span>
              {isRail && (
                <span className={styles.rowSub} data-row-caption>
                  {joinCaption([timeOf(item) || lang('PlannerNoTime'), duration])}
                </span>
              )}
              {isRail && item.note && <span className={styles.feedBlockNote} data-block-note>{item.note}</span>}
              <PlannerUnsentMark id={item.id} />
            </button>
            {!isRail && duration && <span className={pv.dayListMinutes}>{duration}</span>}
          </div>
        );
      })}
    </div>
  );
};

export default memo(PlannerDayList);
