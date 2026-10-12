// Parvane, раздел «Знания»: холст из графа связей. Чистая функция — карточка на каждую заметку, стрелка на
// каждую ссылку `[[…]]` между существующими заметками, места карточек — раскладка графа, растянутая до
// размера настоящих карточек. Результат — обычный документ JSON Canvas: его можно править как любой холст.

import type { CanvasDoc, CanvasEdge, CanvasNode } from './notesCanvas';
import type { GraphNoteInput } from './notesGraph';

import { CANVAS_DEFAULT_NODE_WIDTH, newCanvasId } from './notesCanvas';
import { buildGraph, GRAPH_DEFAULT_SEED, layoutGraph } from './notesGraph';

export type GraphCanvasOptions = {
  cardWidth?: number;
  cardHeight?: number;
  // Просвет между карточками
  gap?: number;
  seed?: number;
  makeId?: () => string;
};

export const GRAPH_CANVAS_CARD_HEIGHT = 140;
export const GRAPH_CANVAS_GAP = 60;

const FILE_SUFFIX = '.md';
// Раскладка считается в своих единицах (длина связи 70) на заведомо большом поле — без сжатия
const LAYOUT_FIELD = 1_000_000;
// Растяжение раскладки до размера карточек: не больше этого, остаток наложений снимает раздвижка
const MAX_SPREAD = 6;
const MIN_OFFSET = 0.5;
const SEPARATION_PASSES = 200;

function titleKey(title: string) {
  return title.trim().toLowerCase();
}

function uniqueId(used: Set<string>, makeId: () => string) {
  let id = makeId();
  for (let attempt = 0; (!id || used.has(id)) && attempt < 16; attempt++) id = makeId();
  // Генератор повторяется: номер делает идентификатор своим
  while (!id || used.has(id)) id = `${id}${used.size.toString(16)}`;
  used.add(id);
  return id;
}

// Во сколько раз растянуть точки, чтобы прямоугольники `width` × `height` с центрами в них не накладывались:
// каждой паре хватает разойтись по одной из осей
function spreadOf(points: { x: number; y: number }[], width: number, height: number) {
  let spread = 1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = Math.max(MIN_OFFSET, Math.abs(points[i].x - points[j].x));
      const dy = Math.max(MIN_OFFSET, Math.abs(points[i].y - points[j].y));
      spread = Math.max(spread, Math.min(width / dx, height / dy));
    }
  }
  return Math.min(MAX_SPREAD, spread);
}

// Раздвижка оставшихся наложений: пара расходится по оси, где перекрытие меньше, поровну в обе стороны.
// Порядок обхода постоянный — результат зависит только от входа
function separate(points: { x: number; y: number }[], width: number, height: number) {
  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    let hasMoved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const overlapX = width - Math.abs(a.x - b.x);
        const overlapY = height - Math.abs(a.y - b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        hasMoved = true;
        if (overlapX < overlapY) {
          const shift = (overlapX / 2) * (a.x <= b.x ? 1 : -1);
          a.x -= shift;
          b.x += shift;
        } else {
          const shift = (overlapY / 2) * (a.y <= b.y ? 1 : -1);
          a.y -= shift;
          b.y += shift;
        }
      }
    }
    if (!hasMoved) return;
  }
}

// Холст из заметок и ссылок между ними. Карточка — на каждую заметку (ежедневные тоже), в порядке входа;
// стрелка — от заметки к той, на которую она ссылается: по одной на пару в каждом направлении, без петель;
// ссылка на заметку, которой ещё нет, стрелки не даёт. Одноимённые заметки получают по карточке, ссылка на
// такое название ведёт к первой. Карточки не накладываются, левый верхний угол холста — в начале координат.
export function canvasFromGraph(notes: GraphNoteInput[], options: GraphCanvasOptions = {}): CanvasDoc {
  const width = options.cardWidth ?? CANVAS_DEFAULT_NODE_WIDTH;
  const height = options.cardHeight ?? GRAPH_CANVAS_CARD_HEIGHT;
  const gap = options.gap ?? GRAPH_CANVAS_GAP;
  const makeId = options.makeId || newCanvasId;

  const seen = new Set<string>();
  const shown = notes.filter((note) => {
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
  if (!shown.length) return { nodes: [], edges: [] };

  const noteIdByTitle = new Map<string, string>();
  shown.forEach((note) => {
    const key = titleKey(note.title);
    if (key && !noteIdByTitle.has(key)) noteIdByTitle.set(key, note.id);
  });
  // Только ссылки на существующие заметки: узлов «ещё нет» на холсте не бывает
  const linked = shown.map((note) => ({
    ...note,
    isDaily: false,
    links: note.links.filter((link) => noteIdByTitle.has(titleKey(link))),
  }));

  const graph = buildGraph({ notes: linked }, { withDays: true, withRecords: false });
  const points = layoutGraph(graph.nodes, graph.edges, {
    width: LAYOUT_FIELD, height: LAYOUT_FIELD, margin: 0, seed: options.seed ?? GRAPH_DEFAULT_SEED,
  }).map(({ x, y }) => ({ x, y }));
  const spread = spreadOf(points, width + gap, height + gap);
  points.forEach((point) => {
    point.x *= spread;
    point.y *= spread;
  });
  separate(points, width + gap, height + gap);
  const minX = Math.min(...points.map(({ x }) => x));
  const minY = Math.min(...points.map(({ y }) => y));

  const usedIds = new Set<string>();
  const cardIdByNote = new Map<string, string>();
  const nodes: CanvasNode[] = shown.map((note, i) => {
    const id = uniqueId(usedIds, makeId);
    cardIdByNote.set(note.id, id);
    return {
      id,
      type: 'file',
      x: Math.round(points[i].x - minX),
      y: Math.round(points[i].y - minY),
      width,
      height,
      file: `${note.title}${FILE_SUFFIX}`,
    };
  });

  const edges: CanvasEdge[] = [];
  const edgeKeys = new Set<string>();
  linked.forEach((note) => {
    note.links.forEach((link) => {
      const targetId = noteIdByTitle.get(titleKey(link))!;
      const key = `${note.id}\u0000${targetId}`;
      if (targetId === note.id || edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({
        id: uniqueId(usedIds, makeId),
        fromNode: cardIdByNote.get(note.id)!,
        toNode: cardIdByNote.get(targetId)!,
      });
    });
  });

  return { nodes, edges };
}

// Свободное название холста: `base`, затем «base 2», «base 3»… (без учёта регистра)
export function freeCanvasTitle(base: string, taken: string[]) {
  const used = new Set(taken.map(titleKey));
  if (!used.has(titleKey(base))) return base;
  for (let n = 2; ; n++) {
    if (!used.has(titleKey(`${base} ${n}`))) return `${base} ${n}`;
  }
}
