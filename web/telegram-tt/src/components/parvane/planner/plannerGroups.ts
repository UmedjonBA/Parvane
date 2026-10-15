// Группы «Плана» (16 окт 2026): прежние списки задач, в которые теперь входят и события. Группа — запись `lists`
// (имя, цвет); задача и событие ссылаются на неё именем (`project`), цвет записи — цвет группы.

import type { PlannerState } from './plannerModel';

import { detachInstance, ensureList } from './plannerModel';

export type GroupError = 'name' | 'duplicate';

// Запись, отмеченная для добавления в группу: экземпляр ряда несёт `day`
export type GroupPick = { kind: 'task' | 'event'; id: string; day?: string; isRepeat: boolean };

const GROUP_NAME_MAX_LENGTH = 60;

export function normalizeGroupName(name: string) {
  return name.trim().slice(0, GROUP_NAME_MAX_LENGTH);
}

export function createGroup(state: PlannerState, rawName: string, color: number): GroupError | undefined {
  const name = normalizeGroupName(rawName);
  if (!name) return 'name';
  if (state.lists.some((list) => list.name === name)) return 'duplicate';
  const list = ensureList(state, name)!;
  if (color) list.color = color;
  return undefined;
}

/** Новое имя группы — и у всех её задач и событий. */
export function renameGroup(state: PlannerState, from: string, rawName: string): GroupError | undefined {
  const name = normalizeGroupName(rawName);
  if (!name) return 'name';
  if (name === from) return undefined;
  if (state.lists.some((list) => list.name === name)) return 'duplicate';
  const list = state.lists.find((item) => item.name === from);
  if (!list) return undefined;
  list.name = name;
  state.projects = state.projects.map((project) => (project === from ? name : project));
  state.tasks.forEach((task) => {
    if (task.project === from) task.project = name;
  });
  state.events.forEach((event) => {
    if (event.project === from) event.project = name;
  });
  return undefined;
}

export function setGroupColor(state: PlannerState, name: string, color: number) {
  const list = state.lists.find((item) => item.name === name);
  if (list) list.color = color || undefined;
}

/** Группа удаляется, её записи остаются без группы. */
export function deleteGroup(state: PlannerState, name: string) {
  state.lists = state.lists.filter((list) => list.name !== name);
  state.projects = state.projects.filter((project) => project !== name);
  state.tasks.forEach((task) => {
    if (task.project === name) task.project = '';
  });
  state.events.forEach((event) => {
    if (event.project === name) event.project = undefined;
  });
}

/**
 * Отмеченные записи — в группу. Повторяющаяся запись с `withRepeats` переходит целиком (весь ряд и его уже
 * отделённые дни), без него — только отмеченный день (он отделяется от ряда).
 */
export function assignToGroup(state: PlannerState, picks: GroupPick[], name: string, withRepeats: boolean) {
  const seriesDone = new Set<string>();
  picks.forEach((pick) => {
    const isSeriesPick = pick.isRepeat && withRepeats;
    if (pick.isRepeat && !withRepeats && pick.day) {
      const project = pick.kind === 'event' ? name || undefined : name;
      detachInstance(state, pick.kind, pick.id, pick.day, { project });
      return;
    }
    if (isSeriesPick && seriesDone.has(`${pick.kind}:${pick.id}`)) return;
    seriesDone.add(`${pick.kind}:${pick.id}`);
    if (pick.kind === 'task') {
      state.tasks.forEach((task) => {
        if (task.id === pick.id || (isSeriesPick && task.origin?.seriesId === pick.id)) task.project = name;
      });
      return;
    }
    state.events.forEach((event) => {
      if (event.id === pick.id || (isSeriesPick && event.origin?.seriesId === pick.id)) {
        event.project = name || undefined;
      }
    });
  });
}
