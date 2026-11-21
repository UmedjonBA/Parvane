import { memo } from '../../../lib/teact/teact';

import type { PlannerEvent, PlannerState, PlannerTask } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayHeading, formatDuration, formatKind, formatRepeatShort, joinCaption, listColorStyle,
} from './plannerFormat';
import {
  getDayEntry, getEventColor, getListColor, instanceKey, isInstanceDone, toMinutes,
} from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerName from './PlannerName';

import styles from './PlannerEditor.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  today: string;
  // Запись открытой карточки (`instanceKey`): строка подсвечена
  selectedKey?: string;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
};

type Row = {
  key: string;
  kind: 'task' | 'event';
  id: string;
  time?: string;
  name: string;
  caption: string;
  color?: number;
  isDone?: boolean;
};

// Компьютер, редактор записи крупно (доска `DkPlanMore`): слева дела дня записи — «время · название» и под ним
// «Тип · длительность · состояние»; строка открытой записи подсвечена, нажатие открывает другую запись
const PlannerEditorDay = ({
  state, day, today, selectedKey, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();
  const entry = getDayEntry(state, day);

  function describeTask(task: PlannerTask) {
    const isDone = task.repeat ? isInstanceDone(task, day) : task.status === 'done';
    return joinCaption([
      formatKind(lang, 'task'),
      task.minutes ? formatDuration(lang, task.minutes) : undefined,
      isDone ? lang('PlannerRecordDoneLower') : task.repeat ? formatRepeatShort(lang, task.repeat) : undefined,
    ]);
  }

  function describeEvent(event: PlannerEvent) {
    const minutes = event.isAllDay ? undefined : toMinutes(event.end) - toMinutes(event.start);
    return joinCaption([
      formatKind(lang, 'event'),
      event.isAllDay ? lang('PlannerAllDayShort') : minutes && minutes > 0 ? formatDuration(lang, minutes) : undefined,
      event.repeat ? formatRepeatShort(lang, event.repeat) : undefined,
    ]);
  }

  const rows: Row[] = [
    ...entry.allDay.map((event): Row => ({
      key: instanceKey(event),
      kind: 'event',
      id: event.id,
      name: event.name,
      caption: describeEvent(event),
      color: getEventColor(state, event),
    })),
    ...entry.timed.map((item): Row => (item.task ? {
      key: instanceKey(item.task),
      kind: 'task',
      id: item.task.id,
      time: item.start,
      name: item.name,
      caption: describeTask(item.task),
      color: getListColor(state, item.task.project),
      isDone: item.task.repeat ? isInstanceDone(item.task, day) : item.task.status === 'done',
    } : {
      key: instanceKey(item.event!),
      kind: 'event',
      id: item.event!.id,
      time: item.start,
      name: item.name,
      caption: describeEvent(item.event!),
      color: getEventColor(state, item.event!),
    })),
    ...entry.untimed.map((task): Row => ({
      key: instanceKey(task),
      kind: 'task',
      id: task.id,
      name: task.name,
      caption: describeTask(task),
      color: getListColor(state, task.project),
      isDone: task.repeat ? isInstanceDone(task, day) : task.status === 'done',
    })),
  ];

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id } = e.currentTarget.dataset;
    if (kind === 'task') onOpenTask(id!, day);
    else onOpenEvent(id!, day);
  });

  return (
    <nav className={styles.day} aria-label={formatDayHeading(lang, day, today)} data-editor-day={day}>
      <h3 className={styles.dayTitle}>{formatDayHeading(lang, day, today)}</h3>
      {!rows.length && <p className={styles.dayEmpty}>{lang('PlannerEditorDayEmpty')}</p>}
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className={buildClassName(
            styles.dayRow, row.key === selectedKey && styles.dayRowOn, row.isDone && styles.dayRowDone,
          )}
          style={listColorStyle(row.color)}
          aria-current={row.key === selectedKey ? 'true' : undefined}
          data-kind={row.kind}
          data-id={row.id}
          data-editor-row={row.key}
          onClick={handleClick}
        >
          <span className={styles.dayTime}>{row.time || '—'}</span>
          <span className={styles.dayText}>
            <span className={styles.dayName}><PlannerName name={row.name} /></span>
            <span className={styles.dayCaption}>{row.caption}</span>
          </span>
        </button>
      ))}
    </nav>
  );
};

export default memo(PlannerEditorDay);
