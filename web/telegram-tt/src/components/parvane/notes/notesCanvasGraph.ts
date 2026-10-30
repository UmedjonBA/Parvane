// Parvane, раздел «Знания»: холст из графа связей. Чистые функции. `canvasFromGraph` — карточка на каждую
// заметку, стрелка на каждую ссылку `[[…]]` между существующими заметками, места карточек — раскладка графа,
// растянутая до размера настоящих карточек. `refreshCanvasFromGraph` — сверка открытого холста с заметками:
// недостающие карточки и стрелки добавляются, свои стрелки исчезнувших ссылок убираются, сделанное руками
// не трогается. Заметки одной папки стоят вместе и обведены группой с названием папки. Холст может помнить
// свой набор заметок (`GraphCanvasScope` в поле `pvGraphScope` файла): обновление берёт новые заметки только
// из него. Результат — обычный документ JSON Canvas: его можно править как любой холст.

import type {
  CanvasDoc, CanvasEdge, CanvasNode, CanvasPoint, CanvasRect,
} from './notesCanvas';
import type { GraphNoteInput } from './notesGraph';

import { boundsOf, CANVAS_DEFAULT_NODE_WIDTH, newCanvasId } from './notesCanvas';
import { CANVAS_GRID, CANVAS_GROUP_PADDING } from './notesCanvasEdit';
import { noteTitleOfPath } from './notesCanvasFiles';
import { folderCaption, isInFolder, ROOT_FOLDER } from './notesFolders';
import { buildGraph, GRAPH_DEFAULT_SEED, layoutGraph } from './notesGraph';

// Набор заметок холста из графа: папки (точный путь, корень — пустая строка; не заданы — все) и заметки дней
// (`false` — без них). Заметок дней выбор папок не касается — как на графе
export type GraphCanvasScope = { folders?: string[]; days?: boolean };

export type GraphCanvasOptions = {
  // Какие заметки брать; не задан — все. Сужающий набор записывается в холст и действует при обновлении
  scope?: GraphCanvasScope;
  // Подпись группы папки по её пути
  folderLabel?: (path: string) => string;
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
// Поле группы: путь папки, чьи заметки она обводит. По нему новая заметка папки находит свою группу
export const GRAPH_FOLDER_FIELD = 'pvFolder';
// Поле файла холста (верхний уровень): набор заметок, из которого холст собран
export const GRAPH_SCOPE_FIELD = 'pvGraphScope';
// Место над рамкой группы под её шапку с названием
export const GRAPH_GROUP_HEAD = 40;

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
// Бюджет сверок «клетка × узел» одного поиска: на плотном поле или с огромным узлом поиск не крутится минутами
const SPOT_MAX_CHECKS = 2_000_000;
// Блок несвязанных заметок встаёт под холстом, если холст заметно шире своей высоты, иначе — справа
const BLOCK_WIDE_RATIO = 2;

const FREE_SPOT_GAP = 40;
// Ряд кластеров папок не шире стольких сторон квадрата той же площади
const PACK_ASPECT = 1.5;

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

// Набор без ограничений не хранится: `undefined`
function cleanScope(scope?: GraphCanvasScope): GraphCanvasScope | undefined {
  const folders = scope?.folders && [...new Set(scope.folders)].sort();
  const result: GraphCanvasScope = { ...(folders && { folders }), ...(scope?.days === false && { days: false }) };
  return Object.keys(result).length ? result : undefined;
}

// Набор заметок, записанный в холсте; у обычного холста и у холста из всех заметок его нет
export function scopeOfCanvas(doc: CanvasDoc): GraphCanvasScope | undefined {
  const raw = doc.extra?.[GRAPH_SCOPE_FIELD];
  if (!raw || typeof raw !== 'object') return undefined;
  const { folders, days } = raw as { folders?: unknown; days?: unknown };
  return cleanScope({
    folders: Array.isArray(folders) ? folders.filter((item): item is string => typeof item === 'string') : undefined,
    days: days === false ? false : undefined,
  });
}

// Заметка входит в набор холста
export function isInCanvasScope(note: Pick<GraphNoteInput, 'folder' | 'isDaily'>, scope?: GraphCanvasScope) {
  if (!scope) return true;
  if (note.isDaily) return scope.days !== false;
  return !scope.folders || scope.folders.includes(note.folder);
}

function withScope(doc: CanvasDoc, scope?: GraphCanvasScope): CanvasDoc {
  return scope ? { ...doc, extra: { ...doc.extra, [GRAPH_SCOPE_FIELD]: scope } } : doc;
}

function isInside(inner: CanvasRect, outer: CanvasRect) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function inflate(rect: CanvasRect, byX: number, byY = byX): CanvasRect {
  return {
    x: rect.x - byX, y: rect.y - byY, width: rect.width + byX * 2, height: rect.height + byY * 2,
  };
}

// Группа папки: первая по слоям группа с этим путём
function folderGroups(nodes: CanvasNode[]) {
  const result = new Map<string, CanvasNode>();
  nodes.forEach((node) => {
    const folder = node[GRAPH_FOLDER_FIELD];
    if (node.type === 'group' && typeof folder === 'string' && !result.has(folder)) result.set(folder, node);
  });
  return result;
}

// Места карточек одного кластера (заметки одной папки): раскладка графа ссылок между ними, растянутая до
// размера карточек. Левый верхний угол кластера — в начале координат
function layoutCluster(
  notes: GraphNoteInput[], width: number, height: number, gap: number, seed: number,
): { spots: CanvasPoint[]; width: number; height: number } {
  const graph = buildGraph({ notes }, { withDays: true, withRecords: false });
  const points = layoutGraph(graph.nodes, graph.edges, {
    width: LAYOUT_FIELD, height: LAYOUT_FIELD, margin: 0, seed,
  }).map(({ x, y }) => ({ x, y }));
  const spread = spreadOf(points, width + gap, height + gap);
  points.forEach((point) => {
    point.x *= spread;
    point.y *= spread;
  });
  separate(points, width + gap, height + gap);
  const minX = Math.min(...points.map(({ x }) => x));
  const minY = Math.min(...points.map(({ y }) => y));
  const spots = points.map(({ x, y }) => ({ x: Math.round(x - minX), y: Math.round(y - minY) }));
  return {
    spots,
    width: Math.max(...spots.map(({ x }) => x)) + width,
    height: Math.max(...spots.map(({ y }) => y)) + height,
  };
}

// Места прямоугольников рядами слева направо: ряд не шире `PACK_ASPECT` сторон квадрата общей площади
// (и не уже самого широкого прямоугольника), между соседями — `gap`
function packBoxes(boxes: { width: number; height: number }[], gap: number): CanvasPoint[] {
  const area = boxes.reduce((sum, box) => sum + (box.width + gap) * (box.height + gap), 0);
  const limit = Math.max(...boxes.map((box) => box.width), Math.sqrt(area) * PACK_ASPECT);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return boxes.map((box) => {
    if (x > 0 && x + box.width > limit) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const at = { x, y };
    x += box.width + gap;
    rowHeight = Math.max(rowHeight, box.height);
    return at;
  });
}

// Холст из заметок и ссылок между ними. Карточка — на каждую заметку (ежедневные тоже), в порядке входа;
// стрелка — от заметки к той, на которую она ссылается: по одной на пару в каждом направлении, без петель;
// ссылка на заметку, которой ещё нет, стрелки не даёт. Одноимённые заметки получают по карточке, ссылка на
// такое название ведёт к первой. Карточки не накладываются, левый верхний угол холста — в начале координат.
// Идентификаторы стрелок начинаются с `GRAPH_EDGE_PREFIX`, карточка несёт идентификатор своей заметки.
// Заметки каждой папки раскладываются своим кластером и обводятся группой (`label` — название папки, поле
// `GRAPH_FOLDER_FIELD` — её путь); заметки без папки — без группы, их кластер первый. Кластеры стоят рядами
// и не накладываются; группы лежат под карточками (в начале списка узлов). `options.scope` оставляет только
// заметки набора и записывается в холст.
export function canvasFromGraph(notes: GraphNoteInput[], options: GraphCanvasOptions = {}): CanvasDoc {
  const width = options.cardWidth ?? CANVAS_DEFAULT_NODE_WIDTH;
  const height = options.cardHeight ?? GRAPH_CANVAS_CARD_HEIGHT;
  const gap = options.gap ?? GRAPH_CANVAS_GAP;
  const makeId = options.makeId || newCanvasId;

  const scope = cleanScope(options.scope);
  const labelOf = options.folderLabel || folderCaption;
  const seed = options.seed ?? GRAPH_DEFAULT_SEED;

  const shown = uniqueNotes(notes).filter((note) => isInCanvasScope(note, scope));
  if (!shown.length) return withScope({ nodes: [], edges: [] }, scope);

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

  // Кластеры: заметки без папки, затем папки по пути
  const byFolder = new Map<string, number[]>();
  linked.forEach((note, i) => byFolder.set(note.folder, [...(byFolder.get(note.folder) || []), i]));
  const folders = [...byFolder.keys()].sort((a, b) => (a < b ? -1 : 1));
  const clusters = folders.map((folder) => {
    const indexes = byFolder.get(folder)!;
    const ids = new Set(indexes.map((i) => linked[i].id));
    // Внутри кластера раскладку тянут только ссылки между его заметками
    const inner = indexes.map((i) => ({
      ...linked[i], links: linked[i].links.filter((link) => ids.has(noteIdByTitle.get(titleKey(link))!)),
    }));
    const layout = layoutCluster(inner, width, height, gap, seed);
    const pad = folder === ROOT_FOLDER ? 0 : CANVAS_GROUP_PADDING;
    const head = folder === ROOT_FOLDER ? 0 : GRAPH_GROUP_HEAD;
    return {
      folder, indexes, layout, pad, head, width: layout.width + pad * 2, height: layout.height + pad * 2 + head,
    };
  });
  const places = packBoxes(clusters, gap);
  // Верх холста — верх карточек и рамок: шапка первой группы в счёт не идёт
  const top = Math.min(...clusters.map(({ head }, c) => places[c].y + head));

  const spots: CanvasPoint[] = [];
  clusters.forEach((cluster, c) => {
    cluster.indexes.forEach((i, k) => {
      spots[i] = {
        x: places[c].x + cluster.pad + cluster.layout.spots[k].x,
        y: places[c].y + cluster.head + cluster.pad + cluster.layout.spots[k].y - top,
      };
    });
  });

  const usedIds = new Set<string>();
  const cardIdByNote = new Map<string, string>();
  const cards: CanvasNode[] = shown.map((note, i) => {
    const id = uniqueId(usedIds, makeId);
    cardIdByNote.set(note.id, id);
    return noteCard(note, id, spots[i], width, height);
  });

  // Взаимные ссылки — одна стрелка с наконечниками с обеих сторон, а не две встречные поверх друг друга
  const edges: CanvasEdge[] = [];
  const edgeByKey = new Map<string, CanvasEdge>();
  linked.forEach((note) => {
    note.links.forEach((link) => {
      const targetId = noteIdByTitle.get(titleKey(link))!;
      const key = `${note.id}${PAIR_SEPARATOR}${targetId}`;
      if (targetId === note.id || edgeByKey.has(key)) return;
      const reverse = edgeByKey.get(`${targetId}${PAIR_SEPARATOR}${note.id}`);
      if (reverse) {
        reverse.fromEnd = 'arrow';
        edgeByKey.set(key, reverse);
        return;
      }
      const edge: CanvasEdge = {
        id: uniqueId(usedIds, makeId, GRAPH_EDGE_PREFIX),
        fromNode: cardIdByNote.get(note.id)!,
        toNode: cardIdByNote.get(targetId)!,
      };
      edgeByKey.set(key, edge);
      edges.push(edge);
    });
  });

  const groups: CanvasNode[] = [];
  clusters.forEach((cluster, c) => {
    if (cluster.folder === ROOT_FOLDER) return;
    groups.push({
      id: uniqueId(usedIds, makeId),
      type: 'group',
      x: places[c].x,
      y: places[c].y + cluster.head - top,
      width: cluster.width,
      height: cluster.height - cluster.head,
      label: labelOf(cluster.folder),
      [GRAPH_FOLDER_FIELD]: cluster.folder,
    });
  });

  return withScope({ nodes: [...groups, ...cards], edges }, scope);
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
    // Наконечник в начале у своей стрелки — знак взаимной ссылки, а не правка
    if (key === 'fromEnd') return value !== 'none' && value !== 'arrow';
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

// Переименованная (либо перенесённая) папка `oldPath` → `newPath`: путь в наборе заметок холста и у групп папки
// и её подпапок. Подпись группы меняется, только если это прежнее название папки — свою подпись человек сохраняет.
// Нечего менять — прежний документ
export function renameCanvasFolder(doc: CanvasDoc, oldPath: string, newPath: string): CanvasDoc {
  if (!oldPath || !newPath || oldPath === newPath) return doc;
  const moved = (path: string) => (isInFolder(path, oldPath) ? `${newPath}${path.slice(oldPath.length)}` : path);
  let isChanged = false;
  const nodes = doc.nodes.map((node) => {
    const folder = node[GRAPH_FOLDER_FIELD];
    if (node.type !== 'group' || typeof folder !== 'string' || moved(folder) === folder) return node;
    isChanged = true;
    const next = moved(folder);
    return {
      ...node,
      [GRAPH_FOLDER_FIELD]: next,
      ...(node.label === folderCaption(folder) && { label: folderCaption(next) }),
    };
  });
  const scope = scopeOfCanvas(doc);
  const folders = scope?.folders?.map(moved);
  const isScopeChanged = Boolean(folders?.some((path, i) => path !== scope!.folders![i]));
  if (!isChanged && !isScopeChanged) return doc;
  const next = { ...doc, nodes };
  return isScopeChanged ? withScope(next, cleanScope({ ...scope, folders })) : next;
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
  let checks = 0;
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
      checks += taken.length + 1;
      if (checks > SPOT_MAX_CHECKS) return undefined;
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
//    ещё нет стрелки в эту сторону (нарисованной или своей). Взаимные ссылки — одна своя стрелка с
//    наконечниками с обеих сторон (`fromEnd: 'arrow'`); встречные свои стрелки прежних холстов сливаются.
// 4. Своя стрелка (`isGraphEdge`), ссылки для которой в заметке-источнике больше нет, убирается — кроме
//    правленой (`isCustomizedEdge`) и той, чья заметка-источник пропала (её ссылки неизвестны).
//    Заметка папки, у которой на холсте есть группа (`GRAPH_FOLDER_FIELD`), встаёт в эту группу: на свободное
//    место внутри либо у края, рамка группы растёт за ней (единственное, что обновление меняет у готового
//    узла). Группу удалили — заметка встаёт как любая другая; новых групп обновление не заводит.
//    У холста с набором заметок (`scopeOfCanvas`) карточки получают только заметки набора.
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

  const scope = scopeOfCanvas(doc);

  if (!doc.nodes.length && !doc.edges.length) {
    const built = canvasFromGraph(shown, { ...options, scope });
    if (!built.nodes.length) return result;
    result.doc = { ...doc, nodes: built.nodes, edges: built.edges };
    result.added = {
      cards: built.nodes.filter(({ type }) => type !== 'group').map(({ id }) => id),
      edges: built.edges.map(({ id }) => id),
    };
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
  let pending = shown.filter((note) => !cardOfNote.has(note.id) && isInCanvasScope(note, scope));

  // Сначала заметки папок, у которых на холсте есть группа: карточка встаёт в группу, рамка растёт за ней
  const groupOfFolder = folderGroups(nodes);
  const apart = CANVAS_GROUP_PADDING + GRAPH_GROUP_HEAD;
  pending = pending.filter((note) => {
    const groupId = groupOfFolder.get(note.folder)?.id;
    const at = groupId === undefined ? -1 : taken.findIndex(({ id }) => id === groupId);
    if (at < 0) return true;
    const frame = taken[at];
    const inside = new Set(taken.filter((node) => node !== frame && isInside(node, frame)).map(({ id }) => id));
    const near = [...(neighbours.get(note.id) || [])].map((id) => cardOfNote.get(id))
      .filter((card): card is CanvasNode => Boolean(card && inside.has(card.id)));
    // Чужое вокруг отодвинуто на поле и шапку группы: выросшая рамка его не заденет
    const others = taken.filter((node) => node !== frame && !isInside(frame, node))
      .map((node) => (inside.has(node.id) ? node : inflate(node, CANVAS_GROUP_PADDING, apart)));
    const spot = findSpot(boundsOf({ nodes: near, edges: [] }) || frame, others, width, height, gap);
    if (!spot) return true;
    place(note, spot);
    const room = inflate({ ...spot, width, height }, CANVAS_GROUP_PADDING);
    if (!isInside(room, frame)) {
      const x = Math.min(frame.x, room.x);
      const y = Math.min(frame.y, room.y);
      taken[at] = {
        ...frame,
        x,
        y,
        width: Math.max(frame.x + frame.width, room.x + room.width) - x,
        height: Math.max(frame.y + frame.height, room.y + room.height) - y,
      };
    }
    return false;
  });
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
  const linksTo = (sourceCard: string, targetCard: string) => {
    const source = noteOfCard.get(sourceCard);
    const target = nodeById.get(targetCard);
    const targetKey = target && cardKey(target);
    return Boolean(source && targetKey && source.links.some((link) => titleKey(link) === targetKey));
  };
  const isOwnEdge = (edge: CanvasEdge) => isGraphEdge(edge) && !isCustomizedEdge(edge);
  let hasEdgeChanges = false;
  const edges: CanvasEdge[] = [];
  doc.edges.forEach((edge) => {
    if (!isOwnEdge(edge) || !noteOfCard.get(edge.fromNode) || !nodeById.get(edge.toNode)) {
      edges.push(edge);
      return;
    }
    const isForward = linksTo(edge.fromNode, edge.toNode);
    // Ссылки пропавшей заметки неизвестны — её сторона двусторонней стрелки остаётся
    const isTargetKnown = Boolean(noteOfCard.get(edge.toNode));
    const isBackward = edge.fromEnd === 'arrow' && (!isTargetKnown || linksTo(edge.toNode, edge.fromNode));
    if (isForward && (isBackward || edge.fromEnd !== 'arrow')) {
      edges.push(edge);
    } else if (isForward) {
      // Обратной ссылки больше нет — наконечник в начале снимается
      edges.push({ ...edge, fromEnd: undefined });
      hasEdgeChanges = true;
    } else if (isBackward) {
      edges.push({
        ...edge,
        fromNode: edge.toNode,
        toNode: edge.fromNode,
        fromSide: edge.toSide,
        toSide: edge.fromSide,
        fromEnd: undefined,
      });
      hasEdgeChanges = true;
    } else {
      result.removed.edges.push(edge.id);
    }
  });
  // Встречные свои стрелки прежних холстов сливаются в одну двустороннюю. Пара — по заметкам, а не по
  // карточкам: у копии карточки той же заметки вторая стрелка не нужна
  const notePair = (from: string, to: string) => {
    const source = noteOfCard.get(from);
    const target = noteOfCard.get(to);
    return source && target ? `${source.id}${PAIR_SEPARATOR}${target.id}` : undefined;
  };
  const ownByPair = new Map<string, number>();
  const merged: CanvasEdge[] = [];
  edges.forEach((edge) => {
    const pair = notePair(edge.fromNode, edge.toNode);
    const reversePair = notePair(edge.toNode, edge.fromNode);
    if (!isOwnEdge(edge) || !pair || !reversePair) {
      merged.push(edge);
      return;
    }
    const reverseAt = ownByPair.get(reversePair);
    if (reverseAt !== undefined) {
      if (merged[reverseAt].fromEnd !== 'arrow') merged[reverseAt] = { ...merged[reverseAt], fromEnd: 'arrow' };
      result.removed.edges.push(edge.id);
      return;
    }
    ownByPair.set(pair, merged.length);
    merged.push(edge);
  });
  const pairs = new Set<string>();
  merged.forEach((edge) => {
    const pair = notePair(edge.fromNode, edge.toNode);
    if (pair) pairs.add(pair);
    const reversePair = notePair(edge.toNode, edge.fromNode);
    if (reversePair && edge.fromEnd === 'arrow') pairs.add(reversePair);
  });
  const addedEdges: CanvasEdge[] = [];
  shown.forEach((note) => {
    links.get(note.id)!.forEach((targetId) => {
      const pair = `${note.id}${PAIR_SEPARATOR}${targetId}`;
      const from = cardOfNote.get(note.id);
      const to = cardOfNote.get(targetId);
      if (!from || !to || pairs.has(pair)) return;
      pairs.add(pair);
      // Есть своя встречная стрелка — она становится двусторонней
      const reverseAt = ownByPair.get(`${targetId}${PAIR_SEPARATOR}${note.id}`);
      if (reverseAt !== undefined) {
        merged[reverseAt] = { ...merged[reverseAt], fromEnd: 'arrow' };
        hasEdgeChanges = true;
        return;
      }
      const reverseAdded = addedEdges.find((edge) => edge.fromNode === to.id && edge.toNode === from.id);
      if (reverseAdded) {
        reverseAdded.fromEnd = 'arrow';
        return;
      }
      addedEdges.push({ id: uniqueId(usedIds, makeId, GRAPH_EDGE_PREFIX), fromNode: from.id, toNode: to.id });
    });
  });
  result.added.edges = addedEdges.map(({ id }) => id);

  const hasChanged = result.renamed.cards.length || addedCards.length || addedEdges.length
    || result.removed.edges.length || hasEdgeChanges;
  if (hasChanged) result.doc = { ...doc, nodes: taken, edges: [...merged, ...addedEdges] };
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
