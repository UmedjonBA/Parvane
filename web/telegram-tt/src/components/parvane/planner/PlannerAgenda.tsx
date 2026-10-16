import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { GroupPick } from './plannerGroups';
import type {
  PlannerDayIndexEntry, PlannerEvent, PlannerState, PlannerTask,
} from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDuration, formatProject, formatRelativeDay, listColorStyle,
} from './plannerFormat';
import { assignToGroup } from './plannerGroups';
import { formatDescriptionLine } from './plannerLinks';
import {
  addDays, AGENDA_DAYS, getDayIndex, getEventColor, getListColor, instanceKey, toMinutes, toTime,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Checkbox from '../../ui/Checkbox';
import Select from '../../ui/Select';
import PlannerGroupBar, { type GroupStats } from './PlannerGroupBar';
import PlannerName from './PlannerName';

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

// Отмеченная запись: что добавить и как показать в предварительном списке
type Picked = GroupPick & { name: string };

// Вид «Список» (spec 018): повестка на 30 дней от выбранного дня, пустые дни пропущены. Строка — время и
// блок цвета записи; срок задачи — красной строкой. Сверху — группы (16 окт 2026): правка группы и режим
// «Добавить в группу» — галочки у записей, предварительный список, «вместе с повторами»
const PlannerAgenda = ({
  state, day, today, onPickDay, onOpenTask, onOpenEvent,
}: OwnProps) => {
  const lang = useLang();

  const [isPicking, setIsPicking] = useState(false);
  const [picks, setPicks] = useState<Record<string, Picked>>({});
  const [target, setTarget] = useState('');
  const [withRepeats, setWithRepeats] = useState(true);

  const days = useMemo(() => {
    const lastDay = addDays(day, AGENDA_DAYS - 1);
    const index = getDayIndex(state, day, lastDay);
    return [...index.entries()]
      .filter(([, entry]) => entry.tasks.length + entry.events.length + entry.deadlines.length)
      .sort(([a], [b]) => (a < b ? -1 : 1));
  }, [state, day]);

  // Записи и время по группам в показанных днях; события на весь день времени не добавляют
  const groupStats = useMemo(() => {
    const stats: GroupStats = {};
    const add = (name: string, minutes: number) => {
      const item = stats[name] || (stats[name] = { count: 0, minutes: 0 });
      item.count += 1;
      item.minutes += Math.max(0, minutes);
    };
    days.forEach(([, entry]) => {
      entry.events.forEach((event) => {
        add(event.project || '', event.isAllDay ? 0 : toMinutes(event.end) - toMinutes(event.start));
      });
      entry.tasks.forEach((task) => add(task.project || '', task.minutes || 0));
    });
    return stats;
  }, [days]);

  const handleDayClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickDay(e.currentTarget.dataset.day!);
  });

  // В режиме выбора нажатие на запись отмечает её, а не открывает
  const togglePick = (key: string, pick: Picked) => {
    setPicks((current) => {
      const next = { ...current };
      if (next[key]) delete next[key];
      else next[key] = pick;
      return next;
    });
  };

  const handleEventClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { eventId, day: eventDay } = e.currentTarget.dataset;
    if (!isPicking) {
      onOpenEvent(eventId!, eventDay!);
      return;
    }
    const event = state.events.find(({ id }) => id === eventId);
    if (!event) return;
    togglePick(`e:${eventId}:${eventDay}`, {
      kind: 'event', id: eventId!, day: eventDay, isRepeat: Boolean(event.repeat), name: event.name,
    });
  });

  const handleTaskClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { taskId, instanceDay } = e.currentTarget.dataset;
    if (!isPicking) {
      onOpenTask(taskId!, instanceDay);
      return;
    }
    const task = state.tasks.find(({ id }) => id === taskId);
    if (!task) return;
    togglePick(`t:${taskId}:${instanceDay || ''}`, {
      kind: 'task', id: taskId!, day: instanceDay, isRepeat: Boolean(task.repeat), name: task.name,
    });
  });

  const handleStartPick = useLastCallback(() => {
    setIsPicking(true);
    setPicks({});
    setWithRepeats(true);
    setTarget((current) => (state.lists.some((list) => list.name === current) ? current : state.lists[0]?.name || ''));
  });

  const handleCancelPick = useLastCallback(() => {
    setIsPicking(false);
    setPicks({});
  });

  const handleTarget = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setTarget(e.currentTarget.value);
  });

  const handleApply = useLastCallback(() => {
    const list = Object.values(picks);
    if (!list.length || !target) return;
    updatePlanner((draft) => {
      assignToGroup(draft, list, target, withRepeats);
    }, lang('PlannerNoticeGroupAdded', { name: target, count: list.length }));
    setIsPicking(false);
    setPicks({});
  });

  const pickedList = Object.values(picks);
  const hasRepeatPicked = pickedList.some((pick) => pick.isRepeat);
  // Ряд, отмеченный в нескольких днях, — одна строка предварительного списка, когда он идёт целиком
  const previewNames = [...new Set(pickedList.map((pick) => (
    pick.isRepeat && withRepeats ? `${pick.name} · ${lang('PlannerRepeatMark')}` : pick.name
  )))];
  const isPicked = (key: string) => Boolean(picks[key]);

  const renderEvent = (event: PlannerEvent, dayKey: string) => (
    <div
      key={`e${instanceKey(event)}`}
      className={buildClassName(
        styles.feedLine,
        isPicking && styles.feedLinePicking,
        isPicked(`e:${event.id}:${dayKey}`) && styles.feedLinePicked,
      )}
    >
      <span className={styles.feedTime}>{event.isAllDay ? lang('PlannerAllDayTiny') : event.start}</span>
      <div
        className={buildClassName(styles.feedBlock, event.isHoliday ? styles.kindDue : styles.kindEvent)}
        style={listColorStyle(getEventColor(state, event))}
      >
        <button
          type="button"
          className={styles.feedBlockOpen}
          data-event-id={event.id}
          data-day={dayKey}
          onClick={handleEventClick}
        >
          <span className={styles.feedBlockName}><PlannerName name={event.name} /></span>
          <span className={styles.feedBlockSub}>
            {event.isAllDay ? lang(event.isHoliday ? 'PlannerHoliday' : 'PlannerAllDay')
              : `${event.start}–${event.end}`}
            {event.repeat ? ` · ${lang('PlannerRepeatMark')}` : ''}
          </span>
          {event.description && (
            <span className={styles.feedBlockNote} data-block-note>{formatDescriptionLine(event.description)}</span>
          )}
        </button>
      </div>
    </div>
  );

  const renderTask = (task: PlannerTask) => {
    const isTimed = Boolean(task.start) && task.minutes !== undefined;
    return (
      <div
        key={`t${instanceKey(task)}`}
        className={buildClassName(
          styles.feedLine,
          isPicking && styles.feedLinePicking,
          isPicked(`t:${task.id}:${task.instanceDay || ''}`) && styles.feedLinePicked,
        )}
      >
        <span className={styles.feedTime}>{task.start || '—'}</span>
        <div
          className={buildClassName(
            styles.feedBlock, styles.kindTask, task.status === 'done' && styles.feedBlockDone,
          )}
          style={listColorStyle(getListColor(state, task.project))}
        >
          <button
            type="button"
            className={styles.feedBlockOpen}
            data-task-id={task.id}
            data-instance-day={task.instanceDay}
            onClick={handleTaskClick}
          >
            <span className={styles.feedBlockName}><PlannerName name={task.name} /></span>
            <span className={styles.feedBlockSub}>
              {isTimed ? `${task.start}–${toTime(toMinutes(task.start!) + task.minutes!)}`
                : [
                  lang('PlannerKindTask').toLowerCase(),
                  task.minutes === undefined ? undefined : formatDuration(lang, task.minutes),
                ].filter(Boolean).join(' · ')}
              {task.repeat ? ` · ${lang('PlannerRepeatMark')}` : ''}
            </span>
            {task.description && (
              <span className={styles.feedBlockNote} data-block-note>{formatDescriptionLine(task.description)}</span>
            )}
          </button>
        </div>
      </div>
    );
  };

  // События на весь день — первыми, дальше события и задачи по времени начала, задачи без времени — в конце
  const renderDayRows = (entry: PlannerDayIndexEntry, dayKey: string) => [
    ...entry.events.map((event) => ({ order: event.isAllDay ? '' : event.start, node: renderEvent(event, dayKey) })),
    ...entry.tasks.map((task) => ({ order: task.start || '99', node: renderTask(task) })),
  ].sort((a, b) => a.order.localeCompare(b.order)).map(({ node }) => node);

  return (
    <div className={styles.agendaLayout} data-planner-view="agenda">
      <aside className={styles.agendaSide}>
        <PlannerGroupBar state={state} stats={groupStats} isPicking={isPicking} onStartPick={handleStartPick} />
        {isPicking && (
          <div className={styles.groupPick} data-group-picking>
            <p className={styles.sheetHint}>{lang('PlannerGroupPickHint')}</p>
            {Boolean(previewNames.length) && (
              <ul className={styles.groupPreview} data-group-preview>
                {previewNames.map((name) => <li key={name} className={styles.groupPreviewItem}>{name}</li>)}
              </ul>
            )}
            <div className={styles.groupPickControls}>
              <span className={styles.small}>{lang('PlannerGroupPicked', { count: pickedList.length })}</span>
              <Select
                id="planner-group-target"
                label={lang('PlannerFieldList')}
                value={target}
                hasArrow
                onChange={handleTarget}
              >
                {state.lists.map((list) => <option key={list.id} value={list.name}>{list.name}</option>)}
              </Select>
              {hasRepeatPicked && (
                <Checkbox label={lang('PlannerGroupWithRepeats')} checked={withRepeats} onCheck={setWithRepeats} />
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={buildClassName(styles.btn, styles.btnAccent)}
                  data-group-apply
                  disabled={!pickedList.length || !target}
                  onClick={handleApply}
                >
                  {lang('PlannerGroupApply')}
                </button>
                <button
                  type="button"
                  className={buildClassName(styles.btn, styles.btnGhost)}
                  onClick={handleCancelPick}
                >
                  {lang('Cancel')}
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>
      <div className={styles.agenda}>
        {!days.length && <p className={styles.empty}>{lang('PlannerAgendaEmpty')}</p>}
        {days.map(([key, entry]) => (
          <section key={key} className={styles.agendaDay} data-day={key}>
            <button
              type="button"
              className={buildClassName(
                styles.agendaDayTitle, key === today && styles.agendaDayToday, entry.isHoliday && styles.red,
              )}
              data-day={key}
              onClick={handleDayClick}
            >
              {`${formatRelativeDay(lang, key, today)}, ${formatDay(lang, key)}`}
            </button>
            {renderDayRows(entry, key)}
            {entry.deadlines.map((task) => (
              <div key={`due-${task.id}`} className={styles.feedLine}>
                <span className={buildClassName(styles.feedTime, styles.red)}>{lang('PlannerDueTiny')}</span>
                <div className={buildClassName(styles.feedBlock, styles.kindDue)}>
                  <button
                    type="button"
                    className={styles.feedBlockOpen}
                    data-task-id={task.id}
                    onClick={handleTaskClick}
                  >
                    <span className={styles.feedBlockName}><PlannerName name={task.name} /></span>
                    <span className={styles.feedBlockSub}>{formatProject(lang, task.project)}</span>
                  </button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
};

export default memo(PlannerAgenda);
