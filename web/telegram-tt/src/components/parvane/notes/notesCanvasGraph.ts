// Parvane, раздел «Знания»: холст из графа связей. Чистые функции. `canvasFromGraph` — карточка на каждую
// заметку, стрелка на каждую ссылку `[[…]]` между существующими заметками, места карточек — раскладка графа,
// растянутая до размера настоящих карточек. `refreshCanvasFromGraph` — сверка открытого холста с заметками:
// недостающие карточки и стрелки добавляются, свои стрелки исчезнувших ссылок убираются, сделанное руками
// не трогается. Результат — обычный документ JSON Canvas: его можно править как любой холст.

import type {
  CanvasDoc, CanvasEdge, CanvasNode, CanvasPoint, CanvasRect,
} from './notesCanvas';
import type { GraphNoteInput } from './notesGraph';

import { boundsOf, CANVAS_DEFAULT_NODE_WIDTH, newCanvasId } from './notesCanvas';
import { CANVAS_GRID } from './notesCanvasEdit';
import { noteTitleOfPath } from './notesCanvasFiles';
import { buildGraph, GRAPH_DEFAULT_SEED, layoutGraph } from './notesGraph';

export type GraphCanvasOptions = {
  cardWidth?: number;
  cardHeight?: number;
  // Просвет между карточками
  gap?: number;
  seed?: number;
  makeId?: () => string;
};

// Итог сверки холста с заметками: списки идентификаторов. `doc` — прежний объект, если менять нечего
export type GraphRefreshResult = {
  doc: CanvasDoc;
  added: { cards: string[]; edges: string[] };
  removed: { edges: string[] };
  // Карточки, перенацеленные на переименованную заметку
  renamed: { cards: string[] };
  // Карточки заметок, которых больше нет: остаются на месте
  missing: { cards: string[] };
};

export const GRAPH_CANVAS_CARD_HEIGHT = 140;
export const GRAPH_CANVAS_GAP = 60;
// Стрелка, поставленная по ссылке (а не нарисованная руками), узнаётся по началу идентификатора
export const GRAPH_EDGE_PREFIX = 'graph-';
// Поле карточки заметки: идентификатор заметки. По нему карточка находит заметку после переименования
export const GRAPH_NOTE_FIELD = 'pvNote';

const FILE_SUFFIX = '.md';
const PATH_SEPARATOR = '/';
const PAIR_SEPARATOR = '\u0000';
// Поля стрелки, которые есть у любой; остальные со значением не по умолчанию — правка пользователя
const EDGE_OWN_KEYS = ['id', 'fromNode', 'toNode'];
// Раскладка считается в своих единицах (длина связи 70) на заведомо большом поле — без сжатия
const LAYOUT_FIELD = 1_000_000;
// Растяжение раскладки до размера карточек: не больше этого, остаток наложений снимает раздвижка
const MAX_SPREAD = 6;
const MIN_OFFSET = 0.5;
const SEPARATION_PASSES = 200;
// Новая карточка ищет место вокруг связанных с ней: шаг — половина клетки, не дальше стольких колец
const SPOT_MAX_RINGS = 240;
// Блок несвязанных заметок встаёт под холстом, если холст заметно шире своей высоты, иначе — справа
const BLOCK_WIDE_RATIO = 2;

const FREE_SPOT_GAP = 40;

function titleKey(title: string) {
  return title.trim().toLowerCase();
}

function uniqueId(used: Set<string>, makeId: () => string, prefix = '') {
  let id = `${prefix}${makeId()}`;
  for (let attempt = 0; (id === prefix || used.has(id)) && attempt < 16; attempt++) id = `${prefix}${makeId()}`;
  // Генератор повторяется: номер делает идентификатор своим
  while (id === prefix || used.has(id)) id = `${id}${used.size.toString(16)}`;
  used.add(id);
  return id;
}

function uniqueNotes(notes: GraphNoteInput[]) {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
}

function noteCard(note: GraphNoteInput, id: string, at: CanvasPoint, width: number, height: number): CanvasNode {
  return {
    id, type: 'file', x: at.x, y: at.y, width, height, file: `${note.title}${FILE_SUFFIX}`, [GRAPH_NOTE_FIELD]: note.id,
  };
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
// Идентификаторы стрелок начинаются с `GRAPH_EDGE_PREFIX`, карточка несёт идентификатор своей заметки.
export function canvasFromGraph(notes: GraphNoteInput[], options: GraphCanvasOptions = {}): CanvasDoc {
  const width = options.cardWidth ?? CANVAS_DEFAULT_NODE_WIDTH;
  const height = options.cardHeight ?? GRAPH_CANVAS_CARD_HEIGHT;
  const gap = options.gap ?? GRAPH_CANVAS_GAP;
  const makeId = options.makeId || newCanvasId;

  const shown = uniqueNotes(notes);
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
    return noteCard(note, id, { x: Math.round(points[i].x - minX), y: Math.round(points[i].y - minY) }, width, height);
  });

  const edges: CanvasEdge[] = [];
  const edgeKeys = new Set<string>();
  linked.forEach((note) => {
    note.links.forEach((link) => {
      const targetId = noteIdByTitle.get(titleKey(link))!;
      const key = `${note.id}${PAIR_SEPARATOR}${targetId}`;
      if (targetId === note.id || edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({
        id: uniqueId(usedIds, makeId, GRAPH_EDGE_PREFIX),
        fromNode: cardIdByNote.get(note.id)!,
        toNode: cardIdByNote.get(targetId)!,
      });
    });
  });

  return { nodes, edges };
}

// ── обновление холста из графа ───────────────────────────────────────────────

// Стрелка поставлена по ссылке (холстом из графа либо обновлением), а не нарисована руками. У холстов,
// созданных до появления обновления, таких стрелок нет: все их стрелки считаются нарисованными
export function isGraphEdge(edge: CanvasEdge) {
  return edge.id.startsWith(GRAPH_EDGE_PREFIX);
}

// Стрелку правили: есть подпись, цвет, заданная сторона, иной вид концов либо любое другое поле сверх
// концов. Такая стрелка — уже пользователя, обновление её не убирает
export function isCustomizedEdge(edge: CanvasEdge) {
  return Object.keys(edge).some((key) => {
    const value = edge[key];
    if (EDGE_OWN_KEYS.includes(key) || value === undefined) return false;
    if (key === 'label') return value !== '';
    if (key === 'toEnd') return value !== 'arrow';
    if (key === 'fromEnd') return value !== 'none';
    return true;
  });
}

function withTitle(path: string, title: string) {
  return `${path.slice(0, path.lastIndexOf(PATH_SEPARATOR) + 1)}${title}${FILE_SUFFIX}`;
}

// Ключ названия заметки у карточки файла `.md`; у прочих узлов его нет
function cardKey(node: CanvasNode) {
  const title = node.type === 'file' ? noteTitleOfPath(node.file) : undefined;
  return title === undefined ? undefined : titleKey(title) || undefined;
}

// Карточки заметки `oldTitle` указывают на `newTitle` (папки в пути остаются). Нечего менять — прежний документ
export function renameCanvasNote(doc: CanvasDoc, oldTitle: string, newTitle: string): CanvasDoc {
  const oldKey = titleKey(oldTitle);
  if (!oldKey || !newTitle.trim() || !doc.nodes.some((node) => cardKey(node) === oldKey)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (
      cardKey(node) === oldKey ? { ...node, file: withTitle(node.file!, newTitle) } : node
    )),
  };
}

function snapUp(value: number) {
  return Math.ceil(value / CANVAS_GRID) * CANVAS_GRID;
}

function isApart(a: CanvasRect, b: CanvasRect, clearance: number) {
  return a.x + a.width + clearance <= b.x || b.x + b.width + clearance <= a.x
    || a.y + a.height + clearance <= b.y || b.y + b.height + clearance <= a.y;
}

// Свободное место для карточки рядом с `around` (рамкой связанных карточек): клетки сетки перебираются
// кольцами от середины рамки наружу, в кольце — от ближних к дальним, при равенстве сначала ниже и правее.
// Место свободно, если карточка с просветом в половину `gap` не задевает ни одного узла, включая группы
function findSpot(
  around: CanvasRect, taken: CanvasRect[], width: number, height: number, gap: number,
): CanvasPoint | undefined {
  const stepX = snapUp((width + gap) / 2);
  const stepY = snapUp((height + gap) / 2);
  const baseX = Math.round((around.x + around.width / 2 - width / 2) / CANVAS_GRID) * CANVAS_GRID;
  const baseY = Math.round((around.y + around.height / 2 - height / 2) / CANVAS_GRID) * CANVAS_GRID;
  const clearance = gap / 2;
  for (let ring = 0; ring <= SPOT_MAX_RINGS; ring++) {
    const cells: { i: number; j: number; distance: number }[] = [];
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        cells.push({ i, j, distance: (i * stepX) ** 2 + (j * stepY) ** 2 });
      }
    }
    cells.sort((a, b) => a.distance - b.distance || b.j - a.j || b.i - a.i);
    for (const { i, j } of cells) {
      const rect = {
        x: baseX + i * stepX, y: baseY + j * stepY, width, height,
      };
      if (taken.every((other) => isApart(rect, other, clearance))) return { x: rect.x, y: rect.y };
    }
  }
  return undefined;
}

// Свободное место для новой карточки с серединой около `center`: карточки, добавленные кнопкой панели,
// не ложатся поверх уже стоящих. Группы местом не считаются — карточку можно положить внутрь группы
export function findFreeSpot(
  doc: CanvasDoc, center: CanvasPoint, width: number, height: number, gap = FREE_SPOT_GAP,
): CanvasPoint {
  const taken = doc.nodes.filter((node) => node.type !== 'group');
  const around = {
    x: center.x, y: center.y, width: 0, height: 0,
  };
  return findSpot(around, taken, width, height, gap) || { x: center.x - width / 2, y: center.y - height / 2 };
}

// Места блока из `count` карточек вне рамки холста `bounds`: справа от неё (столбцами в высоту холста) либо,
// если холст заметно шире своей высоты, под ней (рядами в ширину холста)
function blockSpots(count: number, bounds: CanvasRect, width: number, height: number, gap: number): CanvasPoint[] {
  const isBelow = bounds.width > bounds.height * BLOCK_WIDE_RATIO;
  const room = isBelow
    ? Math.floor((bounds.width + gap) / (width + gap)) : Math.floor((bounds.height + gap) / (height + gap));
  // Карточек в ряду (блок снизу) либо в столбце (блок справа)
  const line = Math.min(count, Math.max(Math.ceil(Math.sqrt(count)), room));
  const x0 = isBelow ? snapUp(bounds.x) : snapUp(bounds.x + bounds.width + gap * 2);
  const y0 = isBelow ? snapUp(bounds.y + bounds.height + gap * 2) : snapUp(bounds.y);
  return Array.from({ length: count }, (_, index) => {
    const along = index % line;
    const across = Math.floor(index / line);
    return {
      x: x0 + (isBelow ? along : across) * (width + gap),
      y: y0 + (isBelow ? across : along) * (height + gap),
    };
  });
}

// Сверка холста с заметками и ссылками между ними. Правила:
// 1. Что есть на холсте — остаётся как есть: место, размер, цвет, текст и порядок слоёв узлов, все группы,
//    текстовые карточки, ссылки, файлы и стрелки, нарисованные руками. Ничего не двигается.
// 2. Заметка без карточки получает её (ежедневные тоже — как в `canvasFromGraph`): на свободном месте рядом
//    с карточками заметок, с которыми она связана ссылкой в любую сторону; несвязанные — блоком справа от
//    холста либо под ним. Новые карточки ложатся поверх остальных (в конец списка узлов).
// 3. На каждую ссылку между заметками, у которых есть карточки, ставится стрелка — если между их карточками
//    ещё нет стрелки в эту сторону (нарисованной или своей).
// 4. Своя стрелка (`isGraphEdge`), ссылки для которой в заметке-источнике больше нет, убирается — кроме
//    правленой (`isCustomizedEdge`) и той, чья заметка-источник пропала (её ссылки неизвестны).
// 5. Карточка пропавшей заметки остаётся (`missing`). Если она несёт идентификатор заметки, которая теперь
//    называется иначе, карточка перенацеливается на новое название (`renamed`).
// Карточка соответствует заметке по названию (последняя часть пути без `.md`, регистр не важен); у
// одноимённых заметок — по порядку. Совсем пустой холст заполняется раскладкой графа, как новый холст из
// графа. Один вход — один результат.
export function refreshCanvasFromGraph(
  doc: CanvasDoc, notes: GraphNoteInput[], options: GraphCanvasOptions = {},
): GraphRefreshResult {
  const width = options.cardWidth ?? CANVAS_DEFAULT_NODE_WIDTH;
  const height = options.cardHeight ?? GRAPH_CANVAS_CARD_HEIGHT;
  const gap = options.gap ?? GRAPH_CANVAS_GAP;
  const makeId = options.makeId || newCanvasId;
  const result: GraphRefreshResult = {
    doc, added: { cards: [], edges: [] }, removed: { edges: [] }, renamed: { cards: [] }, missing: { cards: [] },
  };
  // Заметка без названия карточкой не находится — она бы добавлялась при каждом обновлении
  const shown = uniqueNotes(notes).filter((note) => titleKey(note.title));

  if (!doc.nodes.length && !doc.edges.length) {
    const built = canvasFromGraph(shown, options);
    if (!built.nodes.length) return result;
    result.doc = { ...doc, nodes: built.nodes, edges: built.edges };
    result.added = { cards: built.nodes.map(({ id }) => id), edges: built.edges.map(({ id }) => id) };
    return result;
  }

  const noteById = new Map(shown.map((note) => [note.id, note]));
  const notesByKey = new Map<string, GraphNoteInput[]>();
  shown.forEach((note) => {
    const key = titleKey(note.title);
    notesByKey.set(key, [...(notesByKey.get(key) || []), note]);
  });

  // Карточка пропавшей заметки, знающая её идентификатор, идёт за переименованной заметкой
  const nodes = doc.nodes.map((node) => {
    const key = cardKey(node);
    const noteId = node[GRAPH_NOTE_FIELD];
    const renamedNote = key && !notesByKey.has(key) && typeof noteId === 'string' ? noteById.get(noteId) : undefined;
    if (!renamedNote) return node;
    result.renamed.cards.push(node.id);
    return { ...node, file: withTitle(node.file!, renamedNote.title) };
  });

  // Карточки по названию заметки, в порядке слоёв: k-я карточка названия — k-я заметка с этим названием,
  // лишние карточки (копии) относятся к последней
  const cardCounts = new Map<string, number>();
  const noteOfCard = new Map<string, GraphNoteInput>();
  const cardOfNote = new Map<string, CanvasNode>();
  nodes.forEach((node) => {
    const key = cardKey(node);
    if (!key) return;
    const sameTitle = notesByKey.get(key);
    if (!sameTitle) {
      result.missing.cards.push(node.id);
      return;
    }
    const index = cardCounts.get(key) || 0;
    cardCounts.set(key, index + 1);
    const note = sameTitle[Math.min(index, sameTitle.length - 1)];
    noteOfCard.set(node.id, note);
    if (!cardOfNote.has(note.id)) cardOfNote.set(note.id, node);
  });

  // Ссылки между существующими заметками: название ведёт к первой заметке с ним
  const links = new Map<string, string[]>();
  const neighbours = new Map<string, Set<string>>();
  shown.forEach((note) => {
    const targets: string[] = [];
    note.links.forEach((link) => {
      const target = notesByKey.get(titleKey(link))?.[0];
      if (!target || target.id === note.id || targets.includes(target.id)) return;
      targets.push(target.id);
      neighbours.set(note.id, (neighbours.get(note.id) || new Set<string>()).add(target.id));
      neighbours.set(target.id, (neighbours.get(target.id) || new Set<string>()).add(note.id));
    });
    links.set(note.id, targets);
  });

  // ── недостающие карточки ──
  const usedIds = new Set([...doc.nodes, ...doc.edges].map(({ id }) => id));
  const taken: CanvasNode[] = [...nodes];
  const addedCards: CanvasNode[] = [];
  const place = (note: GraphNoteInput, at: CanvasPoint) => {
    const card = noteCard(note, uniqueId(usedIds, makeId), at, width, height);
    addedCards.push(card);
    taken.push(card);
    cardOfNote.set(note.id, card);
    noteOfCard.set(card.id, note);
  };
  let pending = shown.filter((note) => !cardOfNote.has(note.id));
  // Сначала те, у кого на холсте уже есть связанная карточка; поставленная карточка сама становится опорой
  for (let hasPlaced = true; hasPlaced && pending.length;) {
    hasPlaced = false;
    const rest: GraphNoteInput[] = [];
    pending.forEach((note) => {
      const near = [...(neighbours.get(note.id) || [])].map((id) => cardOfNote.get(id))
        .filter((card): card is CanvasNode => Boolean(card));
      const around = boundsOf({ nodes: near, edges: [] });
      const spot = around && findSpot(around, taken, width, height, gap);
      if (!spot) {
        rest.push(note);
        return;
      }
      place(note, spot);
      hasPlaced = true;
    });
    pending = rest;
  }
  const bounds = boundsOf({ nodes: taken, edges: [] }) || {
    x: 0, y: 0, width: -gap * 2, height: 0,
  };
  blockSpots(pending.length, bounds, width, height, gap).forEach((spot, index) => place(pending[index], spot));
  result.added.cards = addedCards.map(({ id }) => id);

  // ── стрелки ──
  const nodeById = new Map(taken.map((node) => [node.id, node]));
  const edges = doc.edges.filter((edge) => {
    if (!isGraphEdge(edge) || isCustomizedEdge(edge)) return true;
    const source = noteOfCard.get(edge.fromNode);
    const target = nodeById.get(edge.toNode);
    const targetKey = target && cardKey(target);
    if (!source || !targetKey) return true;
    if (source.links.some((link) => titleKey(link) === targetKey)) return true;
    result.removed.edges.push(edge.id);
    return false;
  });
  const pairs = new Set<string>();
  edges.forEach((edge) => {
    const source = noteOfCard.get(edge.fromNode);
    const target = noteOfCard.get(edge.toNode);
    if (source && target) pairs.add(`${source.id}${PAIR_SEPARATOR}${target.id}`);
  });
  const addedEdges: CanvasEdge[] = [];
  shown.forEach((note) => {
    links.get(note.id)!.forEach((targetId) => {
      const pair = `${note.id}${PAIR_SEPARATOR}${targetId}`;
      const from = cardOfNote.get(note.id);
      const to = cardOfNote.get(targetId);
      if (!from || !to || pairs.has(pair)) return;
      pairs.add(pair);
      addedEdges.push({ id: uniqueId(usedIds, makeId, GRAPH_EDGE_PREFIX), fromNode: from.id, toNode: to.id });
    });
  });
  result.added.edges = addedEdges.map(({ id }) => id);

  const hasChanged = result.renamed.cards.length || addedCards.length || addedEdges.length
    || result.removed.edges.length;
  if (hasChanged) result.doc = { ...doc, nodes: taken, edges: [...edges, ...addedEdges] };
  return result;
}

// Свободное название холста: `base`, затем «base 2», «base 3»… (без учёта регистра)
export function freeCanvasTitle(base: string, taken: string[]) {
  const used = new Set(taken.map(titleKey));
  if (!used.has(titleKey(base))) return base;
  for (let n = 2; ; n++) {
    if (!used.has(titleKey(`${base} ${n}`))) return `${base} ${n}`;
  }
}
