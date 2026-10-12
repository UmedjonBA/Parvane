// Parvane, раздел «Знания»: правки холста, которые делает редактор, — размер и сетка, группы, выделение,
// копии, порядок слоёв, стрелки. Чистые функции над документом JSON Canvas: каждая возвращает новый
// документ (или прежний, если менять нечего). Без UI, хранилища и сети.

import type {
  CanvasAnchor, CanvasDoc, CanvasEdge, CanvasEnd, CanvasNode, CanvasPoint, CanvasRect, CanvasSide,
} from './notesCanvas';

import {
  addEdge, CANVAS_PRESET_COLORS, edgeAnchors, findNode, newCanvasId, nodesInGroup, parseCanvas, serializeCanvas,
  updateEdge,
} from './notesCanvas';

export type CanvasHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type CanvasSelection = { nodes: string[]; edges: string[] };
export type CanvasClip = { nodes: CanvasNode[]; edges: CanvasEdge[] };
export type CanvasSize = { width: number; height: number };
export type CanvasCurve = { p: CanvasAnchor; c1: CanvasPoint; c2: CanvasPoint; q: CanvasAnchor };
export type CanvasEnds = { fromEnd?: CanvasEnd; toEnd?: CanvasEnd };
export type CanvasShortcut =
  'undo' | 'redo' | 'selectAll' | 'duplicate' | 'remove' | 'edit' | 'left' | 'right' | 'up' | 'down';
// Что лежит в буфере обмена: узлы холста, адрес страницы либо просто текст
export type CanvasPasted =
  { kind: 'nodes'; clip: CanvasClip } | { kind: 'link'; url: string } | { kind: 'text'; text: string };
export type CanvasKey = {
  key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean;
};

// Шаг сетки: к нему прилипают сдвиг и размер
export const CANVAS_GRID = 10;
// Сдвиг стрелками с Shift
export const CANVAS_NUDGE_BIG = 50;
// Поле между рамкой группы и её содержимым
export const CANVAS_GROUP_PADDING = 20;
export const CANVAS_CARD_MIN: CanvasSize = { width: 80, height: 40 };
export const CANVAS_GROUP_MIN: CanvasSize = { width: 120, height: 80 };
export const CANVAS_COPY_SHIFT = 20;
export const CANVAS_HANDLES: CanvasHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
export const CANVAS_CORNER_HANDLES: CanvasHandle[] = ['ne', 'se', 'sw', 'nw'];
export const CANVAS_EMPTY_SELECTION: CanvasSelection = { nodes: [], edges: [] };
export const CANVAS_SIDE_NORMALS: Record<CanvasSide, CanvasPoint> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

// Карточка, вынесенная за рамку группы меньше чем наполовину, остаётся в группе — рамка растёт
const GROUP_KEEP_SHARE = 0.5;
const EDGE_MIN_BEND = 40;
const EDGE_SAMPLES = 24;
const OPPOSITE: Record<CanvasSide, CanvasSide> = {
  top: 'bottom', bottom: 'top', left: 'right', right: 'left',
};
// Копирование и вставка идут событиями буфера обмена, а не клавишами
const LETTER_SHORTCUTS: Record<string, CanvasShortcut> = { KeyA: 'selectAll', KeyD: 'duplicate' };
const PASTED_TEXT_MAX = 20000;
const PLAIN_SHORTCUTS: Record<string, CanvasShortcut> = {
  Delete: 'remove',
  Backspace: 'remove',
  Enter: 'edit',
  F2: 'edit',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

// ── сетка и размер ───────────────────────────────────────────────────────────

// Ближайшая линия сетки; сетка 1 и меньше — просто целое число
export function snapTo(value: number, grid = CANVAS_GRID) {
  return grid > 1 ? Math.round(value / grid) * grid : Math.round(value);
}

// Сдвиг, после которого левый верхний угол `rect` встаёт на сетку
export function snapDelta(rect: CanvasPoint, dx: number, dy: number, grid = CANVAS_GRID) {
  return { dx: snapTo(rect.x + dx, grid) - rect.x, dy: snapTo(rect.y + dy, grid) - rect.y };
}

export function minSizeOf(node: Pick<CanvasNode, 'type'>): CanvasSize {
  return node.type === 'group' ? CANVAS_GROUP_MIN : CANVAS_CARD_MIN;
}

// Прямоугольник после того, как ручку `handle` протащили на (dx, dy). Двигаются только стороны ручки и
// встают на сетку; противоположные стоят на месте. Меньше `min` прямоугольник не становится
export function resizeRect(
  rect: CanvasRect, handle: CanvasHandle, dx: number, dy: number, min: CanvasSize = CANVAS_CARD_MIN,
  grid = CANVAS_GRID,
): CanvasRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes('w')) left = Math.min(snapTo(left + dx, grid), right - min.width);
  if (handle.includes('e')) right = Math.max(snapTo(right + dx, grid), left + min.width);
  if (handle.includes('n')) top = Math.min(snapTo(top + dy, grid), bottom - min.height);
  if (handle.includes('s')) bottom = Math.max(snapTo(bottom + dy, grid), top + min.height);
  return {
    x: left, y: top, width: right - left, height: bottom - top,
  };
}

// Узел в новом прямоугольнике (после смены размера). Прочие узлы не трогаются: у группы меняется
// только рамка, содержимое остаётся на месте
export function placeNode(doc: CanvasDoc, id: string, rect: CanvasRect): CanvasDoc {
  const node = findNode(doc, id);
  if (!node || isSameRect(rect, node)) return doc;
  const {
    x, y, width, height,
  } = rect;
  return {
    ...doc,
    nodes: doc.nodes.map((item) => (item === node ? {
      ...item, x, y, width, height,
    } : item)),
  };
}

// ── сдвиг и группы ───────────────────────────────────────────────────────────

// Сдвиг нескольких узлов разом. Группа тянет за собой всё, что лежит внутри неё целиком; узел,
// выбранный и сам, и через группу, сдвигается один раз
export function moveNodes(doc: CanvasDoc, ids: string[], dx: number, dy: number): CanvasDoc {
  const moving = withGroupContent(doc, ids);
  if (!moving.size || (!dx && !dy)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (
      moving.has(node.id) ? { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) } : node
    )),
  };
}

// Правило рамки: узел, который до правки лежал в группе целиком, а после неё выступил за рамку меньше чем
// наполовину, остаётся в группе — рамка растягивается до него с полем. Выступил больше чем наполовину —
// вышел из группы, рамка прежняя. Выросшая группа так же растягивает ту, в которой лежала сама
export function growGroups(before: CanvasDoc, after: CanvasDoc, padding = CANVAS_GROUP_PADDING): CanvasDoc {
  const groups = before.nodes.filter((node) => node.type === 'group');
  if (!groups.length || before === after) return after;
  const queue = after.nodes.filter((node) => {
    const was = findNode(before, node.id);
    return was && !isSameRect(was, node);
  }).map((node) => node.id);
  let doc = after;
  // Каждая группа растёт не больше раза на каждый узел — цикл заведомо конечен
  for (let step = 0; queue.length && step < before.nodes.length * groups.length + 1; step++) {
    const id = queue.shift()!;
    const was = findNode(before, id)!;
    groups.forEach((group) => {
      const now = findNode(doc, id);
      const frame = findNode(doc, group.id);
      if (!now || !frame || group.id === id || !isInside(was, group) || isInside(now, frame)) return;
      if (overlapShare(now, frame) < GROUP_KEEP_SHARE) return;
      const grown = unionRect(frame, inflateRect(now, padding));
      doc = { ...doc, nodes: doc.nodes.map((node) => (node.id === group.id ? { ...node, ...grown } : node)) };
      queue.push(group.id);
    });
  }
  return doc;
}

// «По содержимому»: рамка группы — границы узлов внутри неё плюс поле. У пустой группы рамка прежняя
export function fitGroupToContent(doc: CanvasDoc, groupId: string, padding = CANVAS_GROUP_PADDING): CanvasDoc {
  const bounds = boundsOfRects(nodesInGroup(doc, groupId));
  if (!bounds) return doc;
  const rect = inflateRect(bounds, padding);
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === groupId && !isSameRect(node, rect) ? { ...node, ...rect } : node)),
  };
}

// Новая группа вокруг узлов: их границы плюс поле. В списке узлов она встаёт перед первым из них —
// в JSON Canvas порядок узлов есть порядок слоёв, рамка должна лежать под содержимым
export function wrapInGroup(
  doc: CanvasDoc, ids: string[], makeId: () => string = newCanvasId, padding = CANVAS_GROUP_PADDING,
): { doc: CanvasDoc; id?: string } {
  const wrapped = doc.nodes.filter((node) => ids.includes(node.id));
  const bounds = boundsOfRects(wrapped);
  const id = freeId(doc.nodes, makeId);
  if (!bounds || !id) return { doc };
  const group: CanvasNode = { id, type: 'group', ...inflateRect(bounds, padding) };
  const at = doc.nodes.indexOf(wrapped[0]);
  return { doc: { ...doc, nodes: [...doc.nodes.slice(0, at), group, ...doc.nodes.slice(at)] }, id };
}

// ── выделение ────────────────────────────────────────────────────────────────

export function isSelectionEmpty(selection: CanvasSelection) {
  return !selection.nodes.length && !selection.edges.length;
}

// Добавить в выделение либо убрать из него
export function toggleSelected(selection: CanvasSelection, kind: keyof CanvasSelection, id: string): CanvasSelection {
  const list = selection[kind];
  return { ...selection, [kind]: list.includes(id) ? list.filter((item) => item !== id) : [...list, id] };
}

export function selectAll(doc: CanvasDoc): CanvasSelection {
  return { nodes: doc.nodes.map((node) => node.id), edges: doc.edges.map((edge) => edge.id) };
}

// Выделение без узлов и связей, которых в документе уже нет. Ничего не убрано — тот же объект
export function pruneSelection(doc: CanvasDoc, selection: CanvasSelection): CanvasSelection {
  const nodes = selection.nodes.filter((id) => findNode(doc, id));
  const edges = selection.edges.filter((id) => doc.edges.some((edge) => edge.id === id));
  if (nodes.length === selection.nodes.length && edges.length === selection.edges.length) return selection;
  return { nodes, edges };
}

// Прямоугольник по двум углам, заданным в любом порядке
export function rectOfPoints(a: CanvasPoint, b: CanvasPoint): CanvasRect {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
  };
}

// Что попало в рамку выделения: карточка — если рамка её задела, группа — только если вошла в рамку
// целиком (иначе рамка, начатая внутри группы, каждый раз выделяла бы саму группу)
export function nodesInRect(doc: CanvasDoc, rect: CanvasRect): string[] {
  return doc.nodes
    .filter((node) => (node.type === 'group' ? isInside(node, rect) : overlapArea(node, rect) > 0))
    .map((node) => node.id);
}

// Границы выделенных узлов; у пустого выделения их нет
export function selectionBounds(doc: CanvasDoc, ids: string[]): CanvasRect | undefined {
  return boundsOfRects(doc.nodes.filter((node) => ids.includes(node.id)));
}

// Удаление выделенного: узлы уходят вместе со своими связями, содержимое удалённой группы остаётся
export function removeSelection(doc: CanvasDoc, selection: CanvasSelection): CanvasDoc {
  const nodes = doc.nodes.filter((node) => !selection.nodes.includes(node.id));
  const edges = doc.edges.filter((edge) => (
    !selection.edges.includes(edge.id) && !selection.nodes.includes(edge.fromNode)
    && !selection.nodes.includes(edge.toNode)
  ));
  if (nodes.length === doc.nodes.length && edges.length === doc.edges.length) return doc;
  return { ...doc, nodes, edges };
}

// Цвет всему выделенному; `undefined` убирает цвет
export function recolorSelection(doc: CanvasDoc, selection: CanvasSelection, color?: string): CanvasDoc {
  const paint = <T extends { id: string; color?: string }>(items: T[], ids: string[]) => {
    let hasChanged = false;
    const next = items.map((item) => {
      if (!ids.includes(item.id) || item.color === color) return item;
      hasChanged = true;
      const { color: old, ...rest } = item;
      return (color ? { ...rest, color } : rest) as T;
    });
    return hasChanged ? next : items;
  };
  const nodes = paint(doc.nodes, selection.nodes);
  const edges = paint(doc.edges, selection.edges);
  return nodes === doc.nodes && edges === doc.edges ? doc : { ...doc, nodes, edges };
}

// Общий цвет выделенного: один на всех — он, разные или цвета нет — `undefined`
export function colorOfSelection(doc: CanvasDoc, selection: CanvasSelection) {
  const colors = [
    ...doc.nodes.filter((node) => selection.nodes.includes(node.id)),
    ...doc.edges.filter((edge) => selection.edges.includes(edge.id)),
  ].map((item) => item.color);
  const [first] = colors;
  return first && (CANVAS_PRESET_COLORS as string[]).includes(first) && colors.every((color) => color === first)
    ? first : undefined;
}

// ── копии ────────────────────────────────────────────────────────────────────

// Снимок узлов для вставки: сами узлы, содержимое выбранных групп и связи, оба конца которых в снимке
export function copyNodes(doc: CanvasDoc, ids: string[]): CanvasClip {
  const taken = withGroupContent(doc, ids);
  return {
    nodes: doc.nodes.filter((node) => taken.has(node.id)),
    edges: doc.edges.filter((edge) => taken.has(edge.fromNode) && taken.has(edge.toNode)),
  };
}

// Вставка снимка со сдвигом: узлы и связи получают новые id, концы связей переводятся на новые узлы.
// `ids` — id вставленных узлов в порядке снимка
export function pasteClip(
  doc: CanvasDoc, clip: CanvasClip, dx: number, dy: number, makeId: () => string = newCanvasId,
): { doc: CanvasDoc; ids: string[] } {
  const nodes = [...doc.nodes];
  const edges = [...doc.edges];
  const idMap = new Map<string, string>();
  clip.nodes.forEach((node) => {
    const id = freeId(nodes, makeId);
    if (!id) return;
    idMap.set(node.id, id);
    nodes.push({
      ...node, id, x: Math.round(node.x + dx), y: Math.round(node.y + dy),
    });
  });
  clip.edges.forEach((edge) => {
    const fromNode = idMap.get(edge.fromNode);
    const toNode = idMap.get(edge.toNode);
    const id = freeId(edges, makeId);
    if (!fromNode || !toNode || !id) return;
    edges.push({
      ...edge, id, fromNode, toNode,
    });
  });
  if (!idMap.size) return { doc, ids: [] };
  return { doc: { ...doc, nodes, edges }, ids: Array.from(idMap.values()) };
}

// Границы снимка — чтобы поставить его серединой под указатель
export function clipBounds(clip: CanvasClip) {
  return boundsOfRects(clip.nodes);
}

// Снимок текстом для буфера обмена — тот же JSON Canvas, его примет и другой холст, и другое приложение
export function serializeClip(clip: CanvasClip) {
  return serializeCanvas(clip);
}

// Разбор текста из буфера обмена: JSON Canvas с узлами — узлы; одна строка с адресом http(s) — ссылка;
// прочий непустой текст — текст для новой карточки (не длиннее 20 000 знаков)
export function parsePasted(text: string): CanvasPasted | undefined {
  const clean = text.trim();
  if (!clean) return undefined;
  if (clean.startsWith('{')) {
    const { doc, error } = parseCanvas(clean);
    if (!error && doc.nodes.length) return { kind: 'nodes', clip: { nodes: doc.nodes, edges: doc.edges } };
  }
  const url = /^https?:\/\//i.test(clean) ? normalizeCanvasUrl(clean) : undefined;
  return url ? { kind: 'link', url } : { kind: 'text', text: clean.slice(0, PASTED_TEXT_MAX) };
}

// ── слои ─────────────────────────────────────────────────────────────────────

// «На передний план» — в конец списка узлов, «на задний» — в начало; порядок между собой сохраняется
export function reorderNodes(doc: CanvasDoc, ids: string[], place: 'front' | 'back'): CanvasDoc {
  const picked = doc.nodes.filter((node) => ids.includes(node.id));
  if (!picked.length) return doc;
  const rest = doc.nodes.filter((node) => !ids.includes(node.id));
  const nodes = place === 'front' ? [...rest, ...picked] : [...picked, ...rest];
  return nodes.every((node, i) => node === doc.nodes[i]) ? doc : { ...doc, nodes };
}

// ── стрелки ──────────────────────────────────────────────────────────────────

export function oppositeSide(side: CanvasSide) {
  return OPPOSITE[side];
}

// Сторона прямоугольника, ближайшая к точке (точка может быть и внутри, и снаружи)
export function nearestSide(rect: CanvasRect, point: CanvasPoint): CanvasSide {
  const distances: [CanvasSide, number][] = [
    ['top', Math.abs(point.y - rect.y)],
    ['right', Math.abs(point.x - (rect.x + rect.width))],
    ['bottom', Math.abs(point.y - (rect.y + rect.height))],
    ['left', Math.abs(point.x - rect.x)],
  ];
  // Вне прямоугольника расстояние до стороны считается до её отрезка, а не до всей прямой
  const outX = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const outY = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return distances
    .map(([side, distance]) => [side, side === 'top' || side === 'bottom' ? distance + outX : distance + outY] as const)
    .reduce((best, item) => (item[1] < best[1] ? item : best))[0];
}

// Верхняя карточка под точкой (группы не считаются); `exceptId` — карточка, от которой тянут стрелку
export function nodeAtPoint(doc: CanvasDoc, point: CanvasPoint, exceptId?: string): CanvasNode | undefined {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const node = doc.nodes[i];
    if (node.type !== 'group' && node.id !== exceptId && isInside({ ...point, width: 0, height: 0 }, node)) {
      return node;
    }
  }
  return undefined;
}

// Стрелка с заданными сторонами. Те же отказы, что у `addEdge`: петля, нет узла, такая стрелка уже есть
export function connectNodes(
  doc: CanvasDoc, from: string, to: string, sides: { fromSide?: CanvasSide; toSide?: CanvasSide },
  makeId: () => string = newCanvasId,
): CanvasDoc {
  const next = addEdge(doc, from, to, undefined, makeId);
  if (next === doc) return doc;
  return updateEdge(next, next.edges[next.edges.length - 1].id, sides);
}

// Кривая стрелки: концы на сторонах узлов и две опорные точки, отведённые от сторон наружу
export function edgeCurve(doc: CanvasDoc, edge: CanvasEdge): CanvasCurve | undefined {
  const from = findNode(doc, edge.fromNode);
  const to = findNode(doc, edge.toNode);
  if (!from || !to) return undefined;
  const { from: p, to: q } = edgeAnchors(from, to, edge);
  return curveBetween(p, q);
}

export function curveBetween(p: CanvasAnchor, q: CanvasAnchor): CanvasCurve {
  const bend = Math.max(EDGE_MIN_BEND, Math.hypot(q.x - p.x, q.y - p.y) / 3);
  const start = CANVAS_SIDE_NORMALS[p.side];
  const end = CANVAS_SIDE_NORMALS[q.side];
  return {
    p,
    c1: { x: p.x + start.x * bend, y: p.y + start.y * bend },
    c2: { x: q.x + end.x * bend, y: q.y + end.y * bend },
    q,
  };
}

// Точка кривой при t от 0 до 1 (0,5 — место подписи)
export function curvePoint({
  p, c1, c2, q,
}: CanvasCurve, t: number): CanvasPoint {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p.x + b * c1.x + c * c2.x + d * q.x, y: a * p.y + b * c1.y + c * c2.y + d * q.y };
}

export function distanceToCurve(curve: CanvasCurve, point: CanvasPoint) {
  let best = Infinity;
  let last = curvePoint(curve, 0);
  for (let i = 1; i <= EDGE_SAMPLES; i++) {
    const next = curvePoint(curve, i / EDGE_SAMPLES);
    best = Math.min(best, distanceToSegment(point, last, next));
    last = next;
  }
  return best;
}

// Стрелка под точкой: ближайшая из тех, что не дальше `tolerance`; при равенстве — верхняя (последняя)
export function edgeAt(doc: CanvasDoc, point: CanvasPoint, tolerance: number): string | undefined {
  let found: string | undefined;
  let best = tolerance;
  doc.edges.forEach((edge) => {
    const curve = edgeCurve(doc, edge);
    if (!curve) return;
    const distance = distanceToCurve(curve, point);
    if (distance <= best) {
      best = distance;
      found = edge.id;
    }
  });
  return found;
}

// Следующий вид концов стрелки: наконечник в конце (как по умолчанию) → с обеих сторон → без наконечников →
// снова в конце. Значения по умолчанию в файл не пишутся
export function nextEdgeEnds(edge: CanvasEnds): CanvasEnds {
  const hasStart = edge.fromEnd === 'arrow';
  const hasEnd = edge.toEnd !== 'none';
  if (hasEnd && !hasStart) return { fromEnd: 'arrow', toEnd: undefined };
  if (hasEnd && hasStart) return { fromEnd: undefined, toEnd: 'none' };
  return { fromEnd: undefined, toEnd: undefined };
}

// ── прочее ───────────────────────────────────────────────────────────────────

// Адрес для карточки-ссылки: только http и https; адрес без схемы получает https. Иное — `undefined`
export function normalizeCanvasUrl(text: string) {
  const clean = text.trim();
  if (!clean || /\s/.test(clean)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(clean) ? clean : `https://${clean}`;
  try {
    const url = new URL(withScheme);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')
      ? url.toString() : undefined;
  } catch (err) {
    return undefined;
  }
}

// Действие по клавише. Буквы — по положению клавиши (`code`): в русской раскладке Ctrl+Z приходит как «я»
export function canvasShortcut(e: CanvasKey): CanvasShortcut | undefined {
  if (e.altKey) return undefined;
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
    if (e.code === 'KeyY' && !e.shiftKey) return 'redo';
    return e.shiftKey ? undefined : LETTER_SHORTCUTS[e.code];
  }
  const action = PLAIN_SHORTCUTS[e.key];
  // Shift меняет только шаг стрелок
  return e.shiftKey && (action === 'remove' || action === 'edit') ? undefined : action;
}

function withGroupContent(doc: CanvasDoc, ids: string[]) {
  const result = new Set<string>();
  ids.forEach((id) => {
    if (!findNode(doc, id)) return;
    result.add(id);
    nodesInGroup(doc, id).forEach((node) => result.add(node.id));
  });
  return result;
}

function freeId(taken: { id: string }[], makeId: () => string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = makeId();
    if (id && !taken.some((item) => item.id === id)) return id;
  }
  return undefined;
}

function isSameRect(a: CanvasRect, b: CanvasRect) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function isInside(inner: CanvasRect, outer: CanvasRect) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function overlapArea(a: CanvasRect, b: CanvasRect) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function overlapShare(inner: CanvasRect, outer: CanvasRect) {
  const area = inner.width * inner.height;
  return area > 0 ? overlapArea(inner, outer) / area : 0;
}

function inflateRect(rect: CanvasRect, by: number): CanvasRect {
  return {
    x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2,
  };
}

function unionRect(a: CanvasRect, b: CanvasRect): CanvasRect {
  return boundsOfRects([a, b])!;
}

function boundsOfRects(rects: CanvasRect[]): CanvasRect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

function distanceToSegment(point: CanvasPoint, a: CanvasPoint, b: CanvasPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}
