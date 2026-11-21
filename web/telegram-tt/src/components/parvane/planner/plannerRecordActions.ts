import type { LangFn } from '../../../util/localization';
import type { PlannerEvent, PlannerState, PlannerTask } from './plannerModel';
import type { RecordActionKind } from './plannerTools';

import { formatDay } from './plannerFormat';
import {
  addDays, detachInstance, eventInstance, excludeInstance, newId, setTaskDone, taskInstance, toMinutes, toTime,
} from './plannerModel';
import { getPlannerState, updatePlanner } from './plannerStore';
import { getRecordAction } from './plannerTools';

// Parvane, «План» (spec 041, доски `ZdPlanX`, `RdPlan`): действия меню записи по правой кнопке и задача, брошенная
// на шкалу дня. Что делать с записью, решает движок (`plannerRecordAction`), здесь — только запись в состояние

export type PlannerRecordRef = { kind: 'task' | 'event'; id: string; day?: string };

export type PlannerRecordItem = { kind: 'task'; item: PlannerTask } | { kind: 'event'; item: PlannerEvent };

/** Запись для меню: экземпляр ряда на день `day`, иначе сама запись; нет такой — `undefined`. */
export function findRecord(state: PlannerState, ref: PlannerRecordRef): PlannerRecordItem | undefined {
  if (ref.kind === 'task') {
    const task = state.tasks.find(({ id }) => id === ref.id);
    if (!task) return undefined;
    return { kind: 'task', item: task.repeat && ref.day ? taskInstance(task, ref.day) : task };
  }
  const event = state.events.find(({ id }) => id === ref.id);
  if (!event) return undefined;
  return { kind: 'event', item: event.repeat && ref.day ? eventInstance(event, ref.day) : event };
}

/** «Перенести на завтра» либо задача на шкале дня (`place`): правка записи или отделение дня ряда. */
export function moveRecord(
  lang: LangFn, record: PlannerRecordItem, today: string, action: Exclude<RecordActionKind, 'duplicate'>,
  dropDay?: string, dropMinute?: number, step?: number,
) {
  const { kind, item } = record;
  const result = getRecordAction({
    action, item, today, dropDay, dropMinute, step,
  });
  if ((result.mode !== 'move' && result.mode !== 'detach') || !result.day) return false;
  const patch: Partial<PlannerTask & PlannerEvent> = { day: result.day };
  if (result.due) patch.due = result.due;
  if (result.start && result.minutes) {
    patch.start = result.start;
    if (kind === 'task') patch.minutes = result.minutes;
    else patch.end = toTime(toMinutes(result.start) + result.minutes);
  }
  updatePlanner((draft) => {
    if (result.mode === 'detach') {
      detachInstance(draft, kind, item.id, item.instanceDay!, patch);
      return;
    }
    const target = kind === 'task'
      ? draft.tasks.find(({ id }) => id === item.id) : draft.events.find(({ id }) => id === item.id);
    if (target) Object.assign(target, patch);
  }, lang('PlannerNoticeMoved', {
    // «Перенести на завтра» — словом, как на доске `PhStates` («„Зал“ перенесён на завтра»)
    date: result.day === addDays(today, 1) ? lang('PlannerTomorrow').toLowerCase() : formatDay(lang, result.day),
    name: item.name,
  }));
  return true;
}

/** «Дублировать»: копия рядом — день ряда разовой записью, шаблон — таким же рядом. Возвращает id копии. */
export function duplicateRecord(lang: LangFn, record: PlannerRecordItem, today: string) {
  const { kind, item } = record;
  const result = getRecordAction({ action: 'duplicate', item, today });
  if (result.mode !== 'copy' || !result.record) return undefined;
  const id = newId();
  updatePlanner((draft) => {
    if (kind === 'task') {
      const rank = Math.min(0, ...draft.tasks.map((task) => task.rank)) - 1;
      draft.tasks.push({ ...(result.record as PlannerTask), id, rank });
    } else {
      draft.events.push({ ...(result.record as PlannerEvent), id });
    }
  }, lang('PlannerNoticeDuplicated', { name: item.name }));
  return id;
}

/** «Сменить слой»: группа записи; у дня ряда — у всего ряда (слой — свойство ряда). */
export function setRecordGroup(lang: LangFn, record: PlannerRecordItem, project: string) {
  const { kind, item } = record;
  updatePlanner((draft) => {
    if (kind === 'task') {
      const task = draft.tasks.find(({ id }) => id === item.id);
      if (task) task.project = project;
      return;
    }
    const event = draft.events.find(({ id }) => id === item.id);
    if (!event) return;
    event.project = project || undefined;
    // Цвет события — у группы; свой цвет — только без группы
    if (project) event.color = undefined;
  }, lang('PlannerNoticeGroupSet', { name: item.name, group: project || lang('PlannerNoList') }));
}

/** «Отметить выполненным» (задача, у ряда — день). */
export function toggleRecordDone(lang: LangFn, task: PlannerTask) {
  const isDone = task.status !== 'done';
  updatePlanner((draft) => {
    setTaskDone(draft, task, isDone);
  }, lang(isDone ? 'PlannerNoticeDone' : 'PlannerNoticeReopened', { name: task.name }));
}

/** «Удалить»: разовая запись целиком, у ряда — только этот день (отмена — «Отменить» в уведомлении). */
export function deleteRecord(lang: LangFn, record: PlannerRecordItem) {
  const { kind, item } = record;
  updatePlanner((draft) => {
    if (item.repeat && item.instanceDay) {
      excludeInstance(draft, kind, item.id, item.instanceDay);
      return;
    }
    if (kind === 'task') draft.tasks = draft.tasks.filter(({ id }) => id !== item.id);
    else draft.events = draft.events.filter(({ id }) => id !== item.id);
  }, kind === 'task' ? lang('PlannerNoticeTaskDeleted', { name: item.name }) : lang('PlannerNoticeEventDeleted'));
}

/** Свежая запись из хранилища: меню держит ссылку, а состояние могло смениться. */
export function refreshRecord(ref: PlannerRecordRef) {
  return findRecord(getPlannerState(), ref);
}
