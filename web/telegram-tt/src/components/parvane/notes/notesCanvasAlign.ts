// Parvane, раздел «Знания»: выравнивание на холсте — прилипание к краям и серединам соседей при сдвиге и
// смене размера (с направляющими линиями), выравнивание и распределение выделенного. Чистые функции.

import type { CanvasDoc, CanvasNode, CanvasRect } from './notesCanvas';
import type { CanvasHandle, CanvasSize } from './notesCanvasEdit';

import { boundsOfRects, findNode, nodesInGroup } from './notesCanvas';
import { CANVAS_CARD_MIN, moveNodes } from './notesCanvasEdit';

// Направляющая: `axis: 'x'` — вертикальная линия при x = `at` от y = `from` до y = `to`; `'y'` — горизонтальная
export type CanvasGuide = { axis: 'x' | 'y'; at: number; from: number; to: number };
export type CanvasAlign = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type CanvasSnap = { dx: number; dy: number; guides: CanvasGuide[] };

export const CANVAS_ALIGNS: CanvasAlign[] = ['left', 'center', 'right', 'top', 'middle', 'bottom'];
// Ближе этого (в точках холста при масштабе 1) край прилипает к соседу
export const CANVAS_SNAP_DISTANCE = 6;

const SAME = 0.5;

type Axis = 'x' | 'y';

// Сдвиг (dx, dy), после которого край либо середина `moving` встают на край либо середину соседа, если до
// них не дальше `tolerance`. По каждой оси — ближайшее совпадение; нет совпадения — сдвиг по оси 0.
// `guides` — линии через все совпавшие после сдвига края
export function snapToNeighbours(
  moving: CanvasRect, others: CanvasRect[], tolerance = CANVAS_SNAP_DISTANCE,
): CanvasSnap {
  const dx = nearestShift(linesOf(moving, 'x'), others.flatMap((rect) => linesOf(rect, 'x')), tolerance);
  const dy = nearestShift(linesOf(moving, 'y'), others.flatMap((rect) => linesOf(rect, 'y')), tolerance);
  const placed = { ...moving, x: moving.x + (dx || 0), y: moving.y + (dy || 0) };
  return {
    dx: dx || 0,
    dy: dy || 0,
    guides: [
      ...(dx === undefined ? [] : guidesOf(placed, others, 'x', linesOf(placed, 'x'))),
      ...(dy === undefined ? [] : guidesOf(placed, others, 'y', linesOf(placed, 'y'))),
    ],
  };
}

// То же при смене размера: прилипают только стороны, которые двигает ручка; меньше `min` прямоугольник
// не становится (тогда сторона остаётся где была)
export function snapResize(
  rect: CanvasRect, handle: CanvasHandle, others: CanvasRect[], tolerance = CANVAS_SNAP_DISTANCE,
  min: CanvasSize = CANVAS_CARD_MIN,
): { rect: CanvasRect; guides: CanvasGuide[] } {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  const shift = (value: number, axis: Axis) => (
    nearestShift([value], others.flatMap((other) => linesOf(other, axis)), tolerance) || 0
  );
  if (handle.includes('w') && right - (left + shift(left, 'x')) >= min.width) left += shift(left, 'x');
  if (handle.includes('e') && right + shift(right, 'x') - left >= min.width) right += shift(right, 'x');
  if (handle.includes('n') && bottom - (top + shift(top, 'y')) >= min.height) top += shift(top, 'y');
  if (handle.includes('s') && bottom + shift(bottom, 'y') - top >= min.height) bottom += shift(bottom, 'y');
  const next = {
    x: left, y: top, width: right - left, height: bottom - top,
  };
  const xLines = [handle.includes('w') ? [left] : [], handle.includes('e') ? [right] : []].flat();
  const yLines = [handle.includes('n') ? [top] : [], handle.includes('s') ? [bottom] : []].flat();
  return { rect: next, guides: [...guidesOf(next, others, 'x', xLines), ...guidesOf(next, others, 'y', yLines)] };
}

// Выравнивание выделенного по общему краю либо середине его границ. Группа едет вместе с содержимым;
// узел внутри выделенной группы сам не выравнивается. Меньше двух предметов — документ прежний
export function alignNodes(doc: CanvasDoc, ids: string[], align: CanvasAlign): CanvasDoc {
  const items = topItems(doc, ids);
  if (items.length < 2) return doc;
  const axis: Axis = align === 'left' || align === 'center' || align === 'right' ? 'x' : 'y';
  const index = align === 'left' || align === 'top' ? 0 : align === 'center' || align === 'middle' ? 1 : 2;
  const target = linesOf(boundsOf(items), axis)[index];
  return items.reduce((next, item) => {
    const shift = target - linesOf(item, axis)[index];
    return moveNodes(next, [item.id], axis === 'x' ? shift : 0, axis === 'y' ? shift : 0);
  }, doc);
}

// Равные промежутки между предметами вдоль оси: крайние стоят, остальные расходятся между ними.
// Меньше трёх предметов — документ прежний
export function distributeNodes(doc: CanvasDoc, ids: string[], axis: Axis): CanvasDoc {
  const size = axis === 'x' ? 'width' : 'height';
  const items = topItems(doc, ids).sort((a, b) => (a[axis] + a[size] / 2) - (b[axis] + b[size] / 2));
  if (items.length < 3) return doc;
  const first = items[0];
  const last = items[items.length - 1];
  const room = last[axis] + last[size] - first[axis] - items.reduce((sum, item) => sum + item[size], 0);
  const gap = room / (items.length - 1);
  let at = first[axis];
  return items.reduce((next, item) => {
    const shift = Math.round(at) - item[axis];
    at += item[size] + gap;
    return moveNodes(next, [item.id], axis === 'x' ? shift : 0, axis === 'y' ? shift : 0);
  }, doc);
}

// Выделенные узлы без тех, что лежат внутри выделенной же группы
function topItems(doc: CanvasDoc, ids: string[]): CanvasNode[] {
  const nested = new Set<string>();
  ids.forEach((id) => nodesInGroup(doc, id).forEach((node) => nested.add(node.id)));
  return ids.filter((id) => !nested.has(id)).map((id) => findNode(doc, id))
    .filter((node): node is CanvasNode => Boolean(node));
}

// Начало, середина и конец прямоугольника вдоль оси
function linesOf(rect: CanvasRect, axis: Axis) {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.width : rect.height;
  return [start, start + size / 2, start + size];
}

function nearestShift(lines: number[], targets: number[], tolerance: number) {
  let best: number | undefined;
  lines.forEach((line) => targets.forEach((target) => {
    const shift = target - line;
    if (Math.abs(shift) <= tolerance && (best === undefined || Math.abs(shift) < Math.abs(best))) best = shift;
  }));
  return best;
}

// Линии через `lines` прямоугольника `rect`, на которых лежит край либо середина хотя бы одного соседа;
// линия тянется через `rect` и всех таких соседей
function guidesOf(rect: CanvasRect, others: CanvasRect[], axis: Axis, lines: number[]): CanvasGuide[] {
  const cross: Axis = axis === 'x' ? 'y' : 'x';
  const guides: CanvasGuide[] = [];
  lines.forEach((at) => {
    const matched = others.filter((other) => linesOf(other, axis).some((line) => Math.abs(line - at) < SAME));
    if (!matched.length || guides.some((guide) => Math.abs(guide.at - at) < SAME)) return;
    const spans = [rect, ...matched].map((item) => linesOf(item, cross));
    guides.push({
      axis, at, from: Math.min(...spans.map((span) => span[0])), to: Math.max(...spans.map((span) => span[2])),
    });
  });
  return guides;
}

function boundsOf(rects: CanvasRect[]): CanvasRect {
  return boundsOfRects(rects)!;
}
