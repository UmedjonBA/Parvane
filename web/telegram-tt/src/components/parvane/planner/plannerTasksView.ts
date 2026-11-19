import type { PlannerState, PlannerTask } from './plannerModel';

import { addDays, getDayIndex, toMinutes } from './plannerModel';

// Parvane, экран «Задачи» «Плана» (spec 041 E1, доски `PhPlanMore`, `DkPlanMore`): разделы «По срокам» и сведения
// групп. Только отбор записей модели клиента для показа — правил подсчёта, общих с другими клиентами, здесь нет.

export type DeadlineSection = 'overdue' | 'today' | 'week' | 'later';

export type GroupStat = { count: number; minutes: number };

const WEEK_DAYS = 7;
// За сколько дней вперёд считаются записи и часы групп
export const GROUP_STATS_DAYS = 30;

/** Невыполненные задачи со сроком (не ряды), по срокам: просрочено, сегодня, на неделе, позже. */
export function getDeadlineSections(state: PlannerState, today: string) {
  const weekEnd = addDays(today, WEEK_DAYS - 1);
  const sections = new Map<DeadlineSection, PlannerTask[]>();
  state.tasks
    .filter((task) => !task.repeat && task.due && task.status !== 'done')
    .sort((a, b) => a.due!.localeCompare(b.due!) || a.rank - b.rank || (a.id < b.id ? -1 : 1))
    .forEach((task) => {
      const due = task.due!;
      const section: DeadlineSection = due < today ? 'overdue' : due === today ? 'today'
        : due <= weekEnd ? 'week' : 'later';
      const list = sections.get(section) || [];
      list.push(task);
      sections.set(section, list);
    });
  return sections;
}

/** Записи и время по группам на `GROUP_STATS_DAYS` дней с `today` ('' — без группы). */
export function getGroupStats(state: PlannerState, today: string) {
  const stats: Record<string, GroupStat> = {};
  const add = (name: string, minutes: number) => {
    const item = stats[name] || (stats[name] = { count: 0, minutes: 0 });
    item.count += 1;
    item.minutes += Math.max(0, minutes);
  };
  getDayIndex(state, today, addDays(today, GROUP_STATS_DAYS - 1)).forEach((entry) => {
    entry.events.forEach((event) => {
      add(event.project || '', event.isAllDay ? 0 : toMinutes(event.end) - toMinutes(event.start));
    });
    entry.tasks.forEach((task) => add(task.project || '', task.minutes || 0));
  });
  return stats;
}
