import type { PlannerMenuTarget } from './PlannerRecordMenu';

const MINUTES_IN_HOUR = 60;

/**
 * Что под правой кнопкой в «Плане»: запись (`data-kind` + `data-id`, строки задач — `data-task-id`, события списка —
 * `data-event-id`, клетки месяца — `data-preview-task`) с днём экземпляра либо пустое место колонки шкалы
 * (`data-grid-day`, минута — по высоте колонки и часам сетки `data-first-hour` / `data-hours`).
 */
export function getMenuTarget(target: HTMLElement, x: number, y: number): PlannerMenuTarget | undefined {
  const day = findDay(target);
  const block = target.closest<HTMLElement>('[data-kind][data-id]');
  if (block) {
    const kind = block.dataset.kind === 'event' ? 'event' : 'task';
    return { x, y, record: { kind, id: block.dataset.id!, day: block.dataset.day || day } };
  }
  const row = target.closest<HTMLElement>('[data-task-id], [data-event-id]');
  if (row) {
    const kind = row.dataset.eventId ? 'event' : 'task';
    return { x, y, record: { kind, id: (row.dataset.eventId || row.dataset.taskId)!, day } };
  }
  const preview = target.closest<HTMLElement>('[data-preview-task]');
  if (preview) {
    const [id, instanceDay] = preview.dataset.previewTask!.split('@');
    return { x, y, record: { kind: 'task', id, day: instanceDay } };
  }
  const column = target.closest<HTMLElement>('[data-grid-day]');
  if (!column) return undefined;
  return { x, y, grid: { day: column.dataset.gridDay!, minute: getGridMinute(column, y) } };
}

/** Минута шкалы под точкой `y` колонки дня (перетаскивание задачи на шкалу). */
export function getGridMinute(column: HTMLElement, y: number) {
  const grid = column.closest<HTMLElement>('[data-first-hour]')!;
  const rect = column.getBoundingClientRect();
  const hours = Number(grid.dataset.hours);
  return Math.max(0, Math.round(
    Number(grid.dataset.firstHour) * MINUTES_IN_HOUR + ((y - rect.top) / rect.height) * hours * MINUTES_IN_HOUR,
  ));
}

// День экземпляра: у самой строки либо у ближайшего дня вокруг неё
function findDay(target: HTMLElement) {
  const holder = target.closest<HTMLElement>(
    '[data-instance-day], [data-day], [data-day-feed], [data-planner-day], [data-planner-today]',
  );
  if (!holder) return undefined;
  const { instanceDay, day, dayFeed, plannerDay, plannerToday } = holder.dataset;
  return instanceDay || day || dayFeed || plannerDay || plannerToday || undefined;
}
