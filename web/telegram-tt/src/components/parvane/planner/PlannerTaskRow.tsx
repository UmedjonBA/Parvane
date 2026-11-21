import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerTask } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayInline, formatDue, formatDuration, formatKind, formatProject, formatRepeatShort, formatStatus,
  listColorStyle,
} from './plannerFormat';
import {
  addDays, instanceKey, setTaskDone, toDayKey,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerName from './PlannerName';
import PlannerUnsentMark from './PlannerUnsentMark';

import kit from '../notes/PvKit.module.scss';
import styles from './Planner.module.scss';

export const TASK_DRAG_TYPE = 'application/x-parvane-planner-task';

type OwnProps = {
  task: PlannerTask;
  // `all` — строка в списках (дата и список в подписи), `day` — в расписании дня
  context: 'all' | 'day';
  // Цвет списка задачи (0 — нет) — цвет квадрата списка в подписи
  color?: number;
  // Строка стоит на экране своего списка — список в подписи не повторяется
  noProject?: boolean;
  // Кнопка справа от строки (назначение дня у задачи без даты): подпись, описание для чтения с экрана и
  // обработчик — плоскими значениями, чтобы `memo` строки держался (готовый узел был бы новым каждый раз)
  assignLabel?: string;
  assignTitle?: string;
  onAssign?: (taskId: string) => void;
  // Вторая кнопка — «Выбрать день» (доска `DkPlanMore`), так же плоскими значениями
  pickLabel?: string;
  // Экран «Задачи» на телефоне (доска `PhPlanMore`): галочка слева
  isCheckFirst?: boolean;
  onPick?: (taskId: string) => void;
  // `day` — день экземпляра ряда (spec 011)
  onOpen: (taskId: string, day?: string) => void;
};

// Срок ближе этого числа дней выделяется красным
const DUE_SOON_DAYS = 2;

type CaptionPart = { text: string; isRed?: boolean };

// Строка задачи (доски `DkPlanMore`, `PhPlanMore`, `PhonePlan`): галочка, название и подпись одной строкой через
// « · » — в дне «Задача · 30 мин · срок сегодня», в списках «1 ч · Сервер · срок пт · в работе» («без оценки»,
// когда длительности нет). На компьютере галочка слева, на телефоне — справа
const PlannerTaskRow = ({
  task, context, color, noProject, assignLabel, assignTitle, onAssign, pickLabel, isCheckFirst,
  onPick, onOpen,
}: OwnProps) => {
  const lang = useLang();

  const [today] = useState(() => toDayKey(new Date()));

  const isDone = task.status === 'done';

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.currentTarget.checked;
    updatePlanner((draft) => {
      setTaskDone(draft, task, checked);
    }, lang(checked ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
  });

  const handleOpen = useLastCallback(() => {
    onOpen(task.id, task.instanceDay);
  });

  const handleAssign = useLastCallback(() => {
    onAssign?.(task.id);
  });

  const handlePick = useLastCallback(() => {
    onPick?.(task.id);
  });

  const handleDragStart = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_TYPE, instanceKey(task));
    e.dataTransfer.effectAllowed = 'move';
  });

  const hasDue = Boolean(task.due) && !isDone;
  const isDueSoon = hasDue && task.due! <= addDays(today, DUE_SOON_DAYS);
  const doneSteps = task.steps.filter((step) => step.isDone).length;
  const isAll = context === 'all';
  const duration = task.minutes === undefined ? undefined : formatDuration(lang, task.minutes);
  const day = isAll && task.day
    ? [formatDayInline(lang, task.day, today), task.start].filter(Boolean).join(' ') : task.start;
  const parts: CaptionPart[] = [
    isAll ? undefined : { text: formatKind(lang, 'task') },
    { text: duration || (isAll ? lang('PlannerNoEstimate').toLowerCase() : '') },
    isAll && !noProject && task.project ? { text: formatProject(lang, task.project) } : undefined,
    day ? { text: day } : undefined,
    hasDue ? { text: formatDue(lang, task.due!, today), isRed: isDueSoon } : undefined,
    isAll && task.status === 'active' ? { text: formatStatus(lang, 'active').toLowerCase() } : undefined,
    task.steps.length ? { text: lang('PlannerStepsCount', { done: doneSteps, total: task.steps.length }) } : undefined,
    task.repeat ? { text: formatRepeatShort(lang, task.repeat) } : undefined,
  ].filter((part): part is CaptionPart => Boolean(part?.text));
  const hasNotes = task.description.includes('[[');

  return (
    <div
      className={buildClassName(
        styles.row, styles.rowCheckStart, isCheckFirst && styles.rowCheckFirst, isDone && styles.rowDone,
      )}
      style={listColorStyle(color)}
      draggable
      data-task-id={task.id}
      data-instance-day={task.instanceDay}
      onDragStart={handleDragStart}
    >
      <input
        type="checkbox"
        className={styles.check}
        checked={isDone}
        aria-label={lang('PlannerAriaDone', { name: task.name })}
        onChange={handleToggle}
      />
      <button type="button" className={styles.rowBody} data-kind="task" data-id={task.id} onClick={handleOpen}>
        <span className={styles.rowTitle}>
          <PlannerName name={task.name} />
        </span>
        {(Boolean(parts.length) || hasNotes) && (
          <span className={buildClassName(styles.rowSub, styles.rowSubLine)} data-row-caption>
            {parts.map((part, index) => (
              <span
                key={`${index}:${part.text}`}
                className={buildClassName(styles.rowSubPart, part.isRed && styles.red)}
              >
                {index ? ` · ${part.text}` : part.text}
              </span>
            ))}
            {hasNotes && <PlannerName name={task.description} onlyLinks />}
          </span>
        )}
        <PlannerUnsentMark id={task.id} />
      </button>
      {assignLabel !== undefined && (
        <button
          type="button"
          className={kit.chip}
          data-task-id={task.id}
          data-assign-today
          aria-label={assignTitle}
          onClick={handleAssign}
        >
          {assignLabel}
        </button>
      )}
      {pickLabel !== undefined && (
        <button type="button" className={kit.chip} data-pick-day onClick={handlePick}>
          {pickLabel}
        </button>
      )}
    </div>
  );
};

export default memo(PlannerTaskRow);
