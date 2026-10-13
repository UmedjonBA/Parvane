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

const EMPTY_TASKS: PlannerTask[] = [];
// Задачи из заметок по id заметки — один проход по задачам на состояние «Плана» (ключ — массив задач:
// он новый при каждой правке состояния)
const tasksBySourceCache = new WeakMap<PlannerTask[], Map<string, PlannerTask[]>>();
const signatureCache = new WeakMap<PlannerTask[], string>();

/** Задачи «Плана» из заметок, по id заметки-источника. */
export function noteTasksBySource(state: PlannerState): Map<string, PlannerTask[]> {
  let index = tasksBySourceCache.get(state.tasks);
  if (index) return index;
  index = new Map();
  state.tasks.forEach((task) => {
    const chat = task.source?.chat;
    if (!chat?.startsWith(NOTE_SOURCE_PREFIX)) return;
    const noteId = chat.slice(NOTE_SOURCE_PREFIX.length);
    const list = index!.get(noteId);
    if (list) list.push(task);
    else index!.set(noteId, [task]);
  });
  tasksBySourceCache.set(state.tasks, index);
  return index;
}

/** Задачи «Плана», пришедшие из этой заметки. */
export function getNoteTasks(state: PlannerState, noteId: string) {
  return noteTasksBySource(state).get(noteId) || EMPTY_TASKS;
}

/** Подпись задач из заметок: та же строка — в заметках править нечего (галочки и удаления не менялись).
 * Считается один раз на состояние «Плана». */
export function noteTasksSignature(state: PlannerState) {
  const cached = signatureCache.get(state.tasks);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  state.tasks.forEach((task) => {
    if (task.source?.chat?.startsWith(NOTE_SOURCE_PREFIX)) parts.push(`${task.id}:${task.status}`);
  });
  const signature = parts.join('\n');
  signatureCache.set(state.tasks, signature);
  return signature;
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

const PLAN_FIELDS = ['name', 'day', 'start', 'minutes', 'due'] as const;

function fieldsOf(plan: NoteTaskPlan): Pick<PlannerTask, typeof PLAN_FIELDS[number]> {
  return {
    name: plan.name, day: plan.day, start: plan.start, minutes: plan.minutes, due: plan.due,
  };
}

/** Есть ли что править в «Плане» по пунктам заметки: без копии состояния (прежде — `structuredClone` всего
 * плана и два `JSON.stringify` задач на каждое сохранение). */
export function hasNoteTaskChanges(state: PlannerState, noteId: string, tasks: NoteTaskPlan[]) {
  const existing = getNoteTasks(state, noteId);
  const markers = new Set(tasks.map(({ marker }) => marker));
  if (existing.some((task) => !markers.has(markerOfTask(task)))) return true;
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  return tasks.some((plan) => {
    const task = byId.get(noteTaskId(plan.marker));
    if (!task) return true;
    const fields = fieldsOf(plan);
    return PLAN_FIELDS.some((key) => task[key] !== fields[key]) || (task.status === 'done') !== plan.isDone;
  });
}

/** Привести задачи «Плана» к пунктам заметки: создать, поправить, убрать исчезнувшие. `true` — были правки. */
export function applyNoteTasks(state: PlannerState, noteId: string, tasks: NoteTaskPlan[]) {
  const source = noteSourceOf(noteId);
  const markers = new Set(tasks.map(({ marker }) => marker));
  const kept = state.tasks.filter((task) => task.source?.chat !== source || markers.has(markerOfTask(task)));
  let hasChanges = kept.length !== state.tasks.length;
  // Массив задач всегда новый: индексы по прежнему массиву (`noteTasksBySource`) не устаревают
  state.tasks = kept;
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  let minRank = Math.min(0, ...state.tasks.map(({ rank }) => rank));
  tasks.forEach((plan) => {
    const id = noteTaskId(plan.marker);
    const existing = byId.get(id);
    const fields = fieldsOf(plan);
    if (existing) {
      PLAN_FIELDS.forEach((key) => {
        if (existing[key] === fields[key]) return;
        (existing as Record<string, unknown>)[key] = fields[key];
        hasChanges = true;
      });
      if ((existing.status === 'done') !== plan.isDone) {
        existing.status = plan.isDone ? 'done' : 'queue';
        hasChanges = true;
      }
      return;
    }
    minRank -= 1;
    const created: PlannerTask = {
      id,
      description: '',
      steps: [],
      status: plan.isDone ? 'done' : 'queue',
      project: '',
      rank: minRank,
      source: { chat: source, opId: markerToOpId(plan.marker) },
      ...fields,
      name: plan.name,
    };
    state.tasks.push(created);
    byId.set(id, created);
    hasChanges = true;
  });
  return hasChanges;
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
