// Пункты заметки с датой ↔ задачи «Плана» (дизайн, раздел 2): пункт `- [ ]`, в котором есть дата либо срок,
// становится задачей; связь держит метка в конце строки (`^t7f3a`) — пункт можно двигать и править.
// Задача помнит заметку и метку в поле источника: `source.chat = note:<id>`, `source.opId` — метка,
// записанная шестнадцатеричными кодами её символов (движок принимает в `opId` только такие цифры).

import type { PlannerState, PlannerTask } from '../planner/plannerModel';
import type { QuickContext } from '../planner/plannerQuick';

import { parseQuickInput } from '../planner/plannerQuick';
import {
  dedupeTaskMarkers, ensureTaskMarker, findTaskLine, parseNote, removeTaskLine, setTaskDone,
} from './notesModel';

export type NoteTaskPlan = {
  marker: string;
  name: string;
  isDone: boolean;
  day?: string;
  start?: string;
  minutes?: number;
  due?: string;
};

const NOTE_SOURCE_PREFIX = 'note:';

export function noteSourceOf(noteId: string) {
  return `${NOTE_SOURCE_PREFIX}${noteId}`;
}

function markerToOpId(marker: string) {
  return Array.from(marker, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/** Метка пункта, с которым связана задача. */
export function markerOfTask(task: PlannerTask) {
  const opId = task.source?.opId || '';
  return (opId.match(/../g) || []).map((code) => String.fromCharCode(parseInt(code, 16))).join('');
}

export function noteTaskId(marker: string) {
  return `note-${marker}`;
}

/** Задачи «Плана», пришедшие из этой заметки. */
export function getNoteTasks(state: PlannerState, noteId: string) {
  const source = noteSourceOf(noteId);
  return state.tasks.filter((task) => task.source?.chat === source);
}

/** Пункты заметки с датой: текст с проставленными метками и план задач по ним. */
export function planNoteTasks(text: string, ctx: QuickContext, makeId?: () => string) {
  let next = dedupeTaskMarkers(text, makeId).text;
  const tasks: NoteTaskPlan[] = [];
  parseNote(next).tasks.forEach((task) => {
    const draft = parseQuickInput(task.text, { ...ctx, kind: 'task' });
    // Пункт без даты и срока остаётся просто пунктом
    if (draft.error || (!draft.day && !draft.due) || draft.isDayAssumed) return;
    const ensured = ensureTaskMarker(next, task.line, makeId);
    if (!ensured.marker) return;
    next = ensured.text;
    tasks.push({
      marker: ensured.marker,
      name: draft.name,
      isDone: task.isDone,
      day: draft.day,
      start: draft.start,
      minutes: draft.minutes,
      due: draft.due,
    });
  });
  return { text: next, tasks };
}

/** Привести задачи «Плана» к пунктам заметки: создать, поправить, убрать исчезнувшие. `true` — были правки. */
export function applyNoteTasks(state: PlannerState, noteId: string, tasks: NoteTaskPlan[]) {
  const source = noteSourceOf(noteId);
  const markers = new Set(tasks.map(({ marker }) => marker));
  const before = JSON.stringify(state.tasks);
  state.tasks = state.tasks.filter((task) => task.source?.chat !== source || markers.has(markerOfTask(task)));
  tasks.forEach((plan) => {
    const id = noteTaskId(plan.marker);
    const existing = state.tasks.find((task) => task.id === id);
    const fields: Partial<PlannerTask> = {
      name: plan.name, day: plan.day, start: plan.start, minutes: plan.minutes, due: plan.due,
    };
    if (existing) {
      Object.assign(existing, fields);
      if ((existing.status === 'done') !== plan.isDone) existing.status = plan.isDone ? 'done' : 'queue';
      return;
    }
    state.tasks.push({
      id,
      description: '',
      steps: [],
      status: plan.isDone ? 'done' : 'queue',
      project: '',
      rank: Math.min(0, ...state.tasks.map(({ rank }) => rank)) - 1,
      source: { chat: source, opId: markerToOpId(plan.marker) },
      ...fields,
      name: plan.name,
    });
  });
  return JSON.stringify(state.tasks) !== before;
}

/** Обратная сторона: галочки пунктов по задачам «Плана»; пункт задачи, удалённой в «Плане», убирается.
 * `known` — метки, которые уже были связаны с задачами (иначе новый пункт сочли бы удалённым). */
export function applyPlannerToNote(text: string, tasks: PlannerTask[], known: ReadonlySet<string>) {
  let next = text;
  const byMarker = new Map(tasks.map((task) => [markerOfTask(task), task]));
  parseNote(text).tasks.forEach((item) => {
    if (!item.marker) return;
    const task = byMarker.get(item.marker);
    if (!task) {
      if (known.has(item.marker)) next = removeTaskLine(next, item.marker);
      return;
    }
    const line = findTaskLine(next, item.marker);
    if (line !== undefined && (task.status === 'done') !== item.isDone) {
      next = setTaskDone(next, line, task.status === 'done');
    }
  });
  return next;
}
