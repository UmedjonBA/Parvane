import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerTask } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayShort, formatProject, formatStatus, listColorStyle,
} from './plannerFormat';
import {
  addDays, instanceKey, setTaskDone, toDayKey,
} from './plannerModel';
import { updatePlanner } from './plannerStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PlannerName from './PlannerName';

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
  // `day` — день экземпляра ряда (spec 011)
  onOpen: (taskId: string, day?: string) => void;
};

// Срок ближе этого числа дней выделяется красным
const DUE_SOON_DAYS = 2;

// Строка задачи: круглая галочка, название, подпись (срок, шаги, повтор, заметки), справа — время и оценка
const PlannerTaskRow = ({
  task, context, color, noProject, assignLabel, assignTitle, onAssign, onOpen,
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

  const handleDragStart = useLastCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_TYPE, instanceKey(task));
    e.dataTransfer.effectAllowed = 'move';
  });

  const hasDue = Boolean(task.due) && !isDone;
  const dueLabel = !hasDue ? undefined
    : task.due! < today ? lang('PlannerDuePassed')
      : task.due === today ? lang('PlannerDueToday')
        : task.due === addDays(today, 1) ? lang('PlannerDueTomorrow')
          : lang('PlannerDueValue', { date: formatDayShort(lang, task.due!) });
  const isDueSoon = hasDue && task.due! <= addDays(today, DUE_SOON_DAYS);
  const doneSteps = task.steps.filter((step) => step.isDone).length;
  const isListShown = context === 'all' && !noProject && Boolean(task.project);
  const isDayShown = context === 'all' && Boolean(task.day);
  const hasNotes = task.description.includes('[[');
  const hasSub = isListShown || isDayShown || hasDue || Boolean(task.steps.length) || Boolean(task.repeat) || hasNotes;
  const meta = [
    task.start,
    task.minutes === undefined ? undefined : lang('PlannerMinutesShort', { minutes: task.minutes }),
  ].filter(Boolean).join(' · ');

  return (
    <div
      className={buildClassName(styles.row, isDone && styles.rowDone)}
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
          {context === 'all' && task.status === 'active' && (
            <span className={buildClassName(styles.tag, styles.rowTag)}>{formatStatus(lang, 'active')}</span>
          )}
        </span>
        {hasSub && (
          <span className={styles.rowSub}>
            {isListShown && (
              <span className={styles.rowSubItem}>
                <span className={styles.listMark} />
                {formatProject(lang, task.project)}
              </span>
            )}
            {isDayShown && <span>{formatDayShort(lang, task.day!)}</span>}
            {hasDue && (
              <span className={buildClassName(styles.rowSubItem, isDueSoon && styles.red)}>
                <Icon name="flag" />
                {dueLabel}
              </span>
            )}
            {Boolean(task.steps.length) && (
              <span>{lang('PlannerStepsCount', { done: doneSteps, total: task.steps.length })}</span>
            )}
            {task.repeat && <span title={lang('PlannerRepeatMark')}><Icon name="loop" /></span>}
            {hasNotes && <PlannerName name={task.description} onlyLinks />}
          </span>
        )}
      </button>
      {Boolean(meta) && <span className={styles.rowMeta}>{meta}</span>}
      {assignLabel !== undefined && (
        <button
          type="button"
          className={buildClassName(styles.btn, styles.btnGhost)}
          data-task-id={task.id}
          aria-label={assignTitle}
          onClick={handleAssign}
        >
          {assignLabel}
        </button>
      )}
    </div>
  );
};

export default memo(PlannerTaskRow);
