// Parvane, «Заметки»: показ графа по готовой раскладке движка (правило NOTES-1). Чистые функции экрана: вход
// движка из заметок, размеры подписи, обрезка подписи, наконечники стрелок, ручная расстановка поверх раскладки,
// попадание в точку. Сама раскладка — `notesGraphEngine.ts`; здесь ничего не раскладывается.

import type {
  NotesGraphEdge, NotesGraphInput, NotesGraphLabel, NotesGraphLayout, NotesGraphNode, NotesGraphNote,
  NotesGraphRecord, NotesGraphScope,
} from './notesGraphEngine';

import { isInFolder } from './notesFolders';

export type GraphPoint = { x: number; y: number };
export type GraphPlaces = Record<string, GraphPoint>;
// Что показывает граф: область и скрытие узлов — запоминается на устройстве
export type GraphFilter = { scope: NotesGraphScope; hideOrphans: boolean; hideMissing: boolean };
export type GraphNoteSource = {
  id: string; title: string; folder: string; isDaily?: boolean; links: string[]; tags: string[];
};

// Размеры подписи точки под шрифт макета (IBM Plex Sans 13 px): ширина знака, наибольшая ширина и высота
// строки. Одни на граф и малый граф «Связей»; их же возьмут desktop и android
export const NOTES_GRAPH_METRICS = { charWidth: 7, labelMaxWidth: 140, labelHeight: 18 } as const;
// Соотношение сторон поля, к которому стремится упаковка: широкое окно и телефон
export const NOTES_GRAPH_ASPECT_WIDE = 1.5;
export const NOTES_GRAPH_ASPECT_TALL = 0.7;
// Граф крупнее считается после кадра с подписью «Считаем раскладку…», а не в том же кадре
export const NOTES_GRAPH_SYNC_NODES = 300;
export const MISSING_NODE_PREFIX = 'missing:';
export const GRAPH_ALL: GraphFilter = { scope: { kind: 'all' }, hideOrphans: false, hideMissing: false };
export const GRAPH_ARROW = 7;

const ELLIPSIS = '…';
const AROUND_MIN = 1;
const AROUND_MAX = 3;
const TAG_SEPARATOR = '/';
const ALL_NOTES: NotesGraphScope = { kind: 'all' };

/** Вход движка для графа: заметки как есть, размеры подписи макета. */
export function buildGraphInput(
  notes: GraphNoteSource[], records: NotesGraphRecord[], filter: GraphFilter,
  options: { withDays: boolean; withRecords: boolean; aspect: number; places?: GraphPlaces },
): NotesGraphInput {
  const pinned = options.places ? Object.entries(options.places).map(([id, { x, y }]) => ({ id, x, y })) : [];
  return {
    notes: notes.map(toEngineNote),
    records,
    scope: filter.scope,
    hideOrphans: filter.hideOrphans,
    hideMissing: filter.hideMissing,
    withDays: options.withDays,
    withRecords: options.withRecords,
    aspect: options.aspect,
    pinned: pinned.length ? pinned : undefined,
    ...NOTES_GRAPH_METRICS,
  };
}

export function toEngineNote(note: GraphNoteSource): NotesGraphNote {
  return {
    id: note.id, title: note.title, folder: note.folder, links: note.links, tags: note.tags, isDaily: note.isDaily,
  };
}

/** Ключ области: у каждой области своя ручная расстановка. */
export function scopeKey(scope: NotesGraphScope) {
  if (scope.kind === 'folder') return `folder:${scope.folder}`;
  if (scope.kind === 'tag') return `tag:${scope.tag.toLowerCase()}`;
  if (scope.kind === 'around') return `around:${scope.note}:${scope.depth}`;
  return 'all';
}

/** Область из сохранённого значения; непонятное — все заметки. */
export function parseGraphFilter(raw: unknown): GraphFilter {
  if (!raw || typeof raw !== 'object') return GRAPH_ALL;
  const { scope, hideOrphans, hideMissing } = raw as { scope?: unknown; hideOrphans?: unknown; hideMissing?: unknown };
  return { scope: parseScope(scope), hideOrphans: hideOrphans === true, hideMissing: hideMissing === true };
}

function parseScope(raw: unknown): NotesGraphScope {
  if (!raw || typeof raw !== 'object') return { kind: 'all' };
  const {
    kind, folder, tag, note, depth,
  } = raw as Record<string, unknown>;
  if (kind === 'folder' && typeof folder === 'string') return { kind, folder };
  if (kind === 'tag' && typeof tag === 'string' && tag) return { kind, tag };
  if (kind === 'around' && typeof note === 'string' && note) {
    const safe = Math.min(AROUND_MAX, Math.max(AROUND_MIN, Math.round(Number(depth) || AROUND_MIN)));
    return { kind, note, depth: safe as 1 | 2 | 3 };
  }
  return { kind: 'all' };
}

/** Область, которой больше не из чего собраться (папку либо метку убрали, заметку удалили), — все заметки. */
export function resolveGraphScope(scope: NotesGraphScope, notes: GraphNoteSource[]): NotesGraphScope {
  if (scope.kind === 'folder') {
    return notes.some((note) => !note.isDaily && isInFolder(note.folder, scope.folder)) ? scope : ALL_NOTES;
  }
  if (scope.kind === 'tag') {
    const wanted = normalizeTag(scope.tag);
    const hasTag = notes.some((note) => note.tags.some((raw) => {
      const tag = normalizeTag(raw);
      return tag === wanted || tag.startsWith(`${wanted}${TAG_SEPARATOR}`);
    }));
    return hasTag ? scope : ALL_NOTES;
  }
  if (scope.kind === 'around') return notes.some(({ id }) => id === scope.note) ? scope : ALL_NOTES;
  return scope;
}

function normalizeTag(tag: string) {
  return tag.replace(/^#/, '').toLowerCase();
}

/** Подпись, обрезанная по ширине места, которое ей отвёл движок. */
export function clipGraphLabel(text: string, width: number, charWidth: number = NOTES_GRAPH_METRICS.charWidth) {
  const room = Math.max(1, Math.floor(width / charWidth));
  const chars = [...text];
  return chars.length <= room ? text : `${chars.slice(0, Math.max(1, room - 1)).join('')}${ELLIPSIS}`;
}

/** Где ставить текст подписи: точка привязки и выравнивание по стороне. */
export function labelAnchor(label: NotesGraphLabel) {
  const y = label.y + label.h * 0.75;
  if (label.side === 'right') return { x: label.x, y, anchor: 'start' as const };
  if (label.side === 'left') return { x: label.x + label.w, y, anchor: 'end' as const };
  return { x: label.x + label.w / 2, y, anchor: 'middle' as const };
}

/** Наконечник стрелки у конца линии: остриё в (tipX, tipY), смотрит от (fromX, fromY). */
export function arrowHeadPath(fromX: number, fromY: number, tipX: number, tipY: number, size = GRAPH_ARROW) {
  const length = Math.hypot(tipX - fromX, tipY - fromY);
  if (length < size) return undefined;
  const ux = (tipX - fromX) / length;
  const uy = (tipY - fromY) / length;
  const backX = tipX - ux * size;
  const backY = tipY - uy * size;
  const wing = size * 0.5;
  return `M${round(tipX)} ${round(tipY)}L${round(backX - uy * wing)} ${round(backY + ux * wing)}`
    + `L${round(backX + uy * wing)} ${round(backY - ux * wing)}Z`;
}

/** Наконечники связи: у `to`, при взаимной ссылке — и у `from`. Направление — от опорной точки кривой. */
export function edgeHeads(edge: NotesGraphEdge) {
  const heads = [arrowHeadPath(edge.cx, edge.cy, edge.x2, edge.y2)];
  if (edge.mutual) heads.push(arrowHeadPath(edge.cx, edge.cy, edge.x1, edge.y1));
  return heads.filter((head): head is string => Boolean(head));
}

/** Середина линии связи (на кривой) — там стоит крестик выбранной связи; `share` — доля пути от начала. */
export function edgePoint(edge: NotesGraphEdge, share = 0.5): GraphPoint {
  const rest = 1 - share;
  return {
    x: rest * rest * edge.x1 + 2 * rest * share * edge.cx + share * share * edge.x2,
    y: rest * rest * edge.y1 + 2 * rest * share * edge.cy + share * share * edge.y2,
  };
}

/**
 * Ручная расстановка поверх раскладки движка. Движок держит закреплённые точки на их местах сам (`pinned`), так что
 * обычно здесь двигать нечего; точка, чьё место ещё не дошло до движка (раскладка большого графа считается после
 * кадра), стоит на своём месте, её подпись едет за ней, её связи — прямые от края кружка до края кружка.
 */
export function applyGraphPlaces(layout: NotesGraphLayout, places: GraphPlaces): NotesGraphLayout {
  const movedIds = new Set(layout.nodes.filter(({ id, x, y }) => (
    places[id] && (places[id].x !== x || places[id].y !== y)
  )).map(({ id }) => id));
  if (!movedIds.size) return layout;
  const nodes = layout.nodes.map((node) => (movedIds.has(node.id) ? moveGraphNode(node, places[node.id]) : node));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = layout.edges.map((edge) => (
    movedIds.has(edge.from) || movedIds.has(edge.to)
      ? straightGraphEdge(edge, byId.get(edge.from)!, byId.get(edge.to)!) : edge
  ));
  return { ...layout, nodes, edges };
}

export function moveGraphNode(node: NotesGraphNode, at: GraphPoint): NotesGraphNode {
  return {
    ...node,
    x: at.x,
    y: at.y,
    label: { ...node.label, x: node.label.x + at.x - node.x, y: node.label.y + at.y - node.y },
  };
}

export function straightGraphEdge(edge: NotesGraphEdge, from: NotesGraphNode, to: NotesGraphNode): NotesGraphEdge {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  // Кружки вплотную либо внахлёст — линия от центра к центру
  const isClose = length <= from.r + to.r;
  const x1 = isClose ? from.x : from.x + ux * from.r;
  const y1 = isClose ? from.y : from.y + uy * from.r;
  const x2 = isClose ? to.x : to.x - ux * to.r;
  const y2 = isClose ? to.y : to.y - uy * to.r;
  return {
    ...edge, x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, curved: false,
  };
}

/** Прямоугольник всего показанного: кружки и подписи (для «Вписать»). */
export function graphRects(nodes: NotesGraphNode[]) {
  return nodes.flatMap((node) => [
    {
      x: node.x - node.r, y: node.y - node.r, width: node.r * 2, height: node.r * 2,
    },
    {
      x: node.label.x, y: node.label.y, width: node.label.w, height: node.label.h,
    },
  ]);
}

/** Соседи узла (сам узел не входит). */
export function neighboursOf(nodeId: string, edges: Pick<NotesGraphEdge, 'from' | 'to'>[]) {
  const result = new Set<string>();
  edges.forEach((edge) => {
    if (edge.from === nodeId && edge.to !== nodeId) result.add(edge.to);
    if (edge.to === nodeId && edge.from !== nodeId) result.add(edge.from);
  });
  return result;
}

/** Узел под точкой поля (ближайший из тех, в чей кружок с запасом `slop` она попала). */
export function nodeAt(nodes: NotesGraphNode[], x: number, y: number, slop = 0) {
  let found: NotesGraphNode | undefined;
  let best = Infinity;
  nodes.forEach((node) => {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= node.r + slop && distance < best) {
      best = distance;
      found = node;
    }
  });
  return found;
}

// Связь проводят от заметки (у неё есть текст, куда пишется ссылка) к заметке — существующей либо той, которой
// ещё нет. Заметки дней и записи «Плана» в правке связей не участвуют
export function canLinkFrom(node?: Pick<NotesGraphNode, 'kind'>) {
  return node?.kind === 'note';
}

export function canLinkTo(node?: Pick<NotesGraphNode, 'kind'>) {
  return node?.kind === 'note' || node?.kind === 'missing';
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
