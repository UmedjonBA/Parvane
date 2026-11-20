// Parvane, «Заметки»: правка стрелки холста из панели стрелки (доска `ZdNotesX`) и перецепление её конца на
// другую карточку. Чистые функции над документом JSON Canvas.
//
// Направление — наконечники концов (`fromEnd`/`toEnd` JSON Canvas; по умолчанию стрелка только на конце).
// Пунктир — поле `styleAttributes.path` (так его пишет расширение Advanced Canvas для Obsidian): холст, открытый
// там, покажет тот же пунктир; прочие поля `styleAttributes` сохраняются.

import type { CanvasDoc, CanvasEdge, CanvasSide } from './notesCanvas';

import { updateEdge } from './notesCanvas';

export type CanvasEdgeDirection = 'forward' | 'back' | 'both' | 'none';
export type CanvasEdgeLine = 'solid' | 'dashed';
export type CanvasEdgeEnd = 'from' | 'to';

export const CANVAS_EDGE_DIRECTIONS: CanvasEdgeDirection[] = ['forward', 'back', 'both', 'none'];
export const CANVAS_EDGE_LINES: CanvasEdgeLine[] = ['solid', 'dashed'];

const DASHED_PATH = 'long-dashed';
const DASHED_PATHS = ['dotted', 'short-dashed', 'long-dashed'];

export function edgeDirectionOf(edge: Pick<CanvasEdge, 'fromEnd' | 'toEnd'>): CanvasEdgeDirection {
  const hasStart = edge.fromEnd === 'arrow';
  const hasEnd = edge.toEnd !== 'none';
  if (hasStart && hasEnd) return 'both';
  if (hasStart) return 'back';
  return hasEnd ? 'forward' : 'none';
}

export function setEdgeDirection(doc: CanvasDoc, id: string, direction: CanvasEdgeDirection): CanvasDoc {
  const hasStart = direction === 'back' || direction === 'both';
  const hasEnd = direction === 'forward' || direction === 'both';
  return updateEdge(doc, id, {
    fromEnd: hasStart ? 'arrow' : undefined,
    toEnd: hasEnd ? undefined : 'none',
  });
}

export function edgeLineOf(edge: CanvasEdge): CanvasEdgeLine {
  const path = isRecord(edge.styleAttributes) ? edge.styleAttributes.path : undefined;
  return typeof path === 'string' && DASHED_PATHS.includes(path) ? 'dashed' : 'solid';
}

export function setEdgeLine(doc: CanvasDoc, id: string, line: CanvasEdgeLine): CanvasDoc {
  const edge = doc.edges.find((item) => item.id === id);
  if (!edge || edgeLineOf(edge) === line) return doc;
  const { path, ...rest } = isRecord(edge.styleAttributes) ? edge.styleAttributes : {};
  const next = line === 'dashed' ? { ...rest, path: DASHED_PATH } : rest;
  return updateEdge(doc, id, { styleAttributes: Object.keys(next).length ? next : undefined });
}

// «Поменять концы»: начало и конец меняются местами вместе со сторонами и наконечниками — стрелка смотрит
// в обратную сторону, рисунок линии тот же
export function swapEdgeEnds(doc: CanvasDoc, id: string): CanvasDoc {
  const edge = doc.edges.find((item) => item.id === id);
  if (!edge) return doc;
  const fromEnd = edge.toEnd === 'none' ? undefined : 'arrow';
  const toEnd = edge.fromEnd === 'arrow' ? undefined : 'none';
  return moveEdgeEnds(doc, id, {
    fromNode: edge.toNode,
    toNode: edge.fromNode,
    fromSide: edge.toSide,
    toSide: edge.fromSide,
    fromEnd,
    toEnd,
  });
}

// Конец стрелки перецеплен на карточку `nodeId` (сторона — ближайшая к точке, где его отпустили). На ту же
// карточку, что держит другой конец, стрелка не цепляется: петли на холсте не рисуются
export function reconnectEdge(
  doc: CanvasDoc, id: string, end: CanvasEdgeEnd, nodeId: string, side: CanvasSide,
): CanvasDoc {
  const edge = doc.edges.find((item) => item.id === id);
  if (!edge || !doc.nodes.some((node) => node.id === nodeId)) return doc;
  const other = end === 'from' ? edge.toNode : edge.fromNode;
  if (other === nodeId) return doc;
  if (end === 'from') {
    if (edge.fromNode === nodeId && edge.fromSide === side) return doc;
    return moveEdgeEnds(doc, id, { fromNode: nodeId, fromSide: side });
  }
  if (edge.toNode === nodeId && edge.toSide === side) return doc;
  return moveEdgeEnds(doc, id, { toNode: nodeId, toSide: side });
}

// `updateEdge` концы стрелки не трогает нарочно; здесь — только перецепление и обмен концов
function moveEdgeEnds(doc: CanvasDoc, id: string, patch: Partial<CanvasEdge>): CanvasDoc {
  return {
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      const next: CanvasEdge = { ...edge, ...patch, id };
      (Object.keys(next) as (keyof CanvasEdge)[]).forEach((key) => {
        if (next[key] === undefined) delete next[key];
      });
      return next;
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && Boolean(value) && !Array.isArray(value);
}

// Перетащенный на холст текст из одних ссылок на заметки (`[[Название]]` построчно, как их копирует меню заметки)
// — карточки этих заметок; иначе `undefined`, и текст ложится на холст как вставка
export function parseDroppedNotes(text: string): string[] | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const titles: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]$/);
    if (!match) return undefined;
    const title = match[1].trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles.length ? titles : undefined;
}
