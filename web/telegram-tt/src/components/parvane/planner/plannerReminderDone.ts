import { parseReminderKey } from '../../../util/systemNotify';
import { setTaskDone, taskInstance } from './plannerModel';
import { getIsPlannerLoaded, getPlannerState, loadPlanner, updatePlanner } from './plannerStore';

/**
 * «Готово» в уведомлении напоминания (spec 041 F2): задача (экземпляр ряда — на день напоминания) отмечается
 * выполненной. Напоминание о событии отмечать нечем — только закрывается. Возвращает, отмечено ли.
 */
export async function markReminderDone(key: string, userId?: string) {
  const reminder = parseReminderKey(key);
  if (!reminder) return false;
  await loadPlanner(userId);
  if (!getIsPlannerLoaded()) return false;
  if (!getPlannerState().tasks.some((task) => task.id === reminder.id)) return false;
  updatePlanner((draft) => {
    const task = draft.tasks.find(({ id }) => id === reminder.id)!;
    setTaskDone(draft, task.repeat ? taskInstance(task, reminder.day) : task, true);
  });
  return true;
}
