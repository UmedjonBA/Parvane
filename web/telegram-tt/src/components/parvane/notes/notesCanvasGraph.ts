// Parvane, «Заметки»: холст из графа связей. `canvasFromGraph` — карточка на каждую заметку области, стрелка
// на каждую ссылку `[[…]]` между ними; места карточек и стороны стрелок считает движок (`layoutNotesCanvas`,
// правило NOTES-1: связные заметки уровнями, одиночные сеткой по папкам) — здесь только сборка документа.
// `refreshCanvasFromGraph` — сверка открытого холста с заметками: недостающие карточки и стрелки добавляются,
// свои стрелки исчезнувших ссылок убираются, сделанное руками не трогается. Холст помнит область, из которой
// собран (`GraphCanvasScope` в поле `pvGraphScope` файла): по ней холст узнаётся как «холст из графа», и
// обновление берёт новые заметки только из неё. Результат — обычный документ JSON Canvas.

import type {
  CanvasDoc, CanvasEdge, CanvasNode, CanvasPoint, CanvasRect,
} from './notesCanvas';
import type { NotesGraphInput, NotesGraphNote, NotesGraphScope } from './notesGraphEngine';

import { boundsOf, CANVAS_DEFAULT_NODE_WIDTH, newCanvasId } from './notesCanvas';
import { CANVAS_GRID } from './notesCanvasEdit';
import { noteTitleOfPath } from './notesCanvasFiles';
import { isInFolder } from './notesFolders';
import { layoutNotesCanvas } from './notesGraphEngine';
import { parseGraphFilter } from './notesGraphView';

// Область холста из графа: та же, что у графа (`scope`: все / папка с подпапками / вокруг заметки / метка),
// «без одиночных» и заметки дней (`false` — без них)
export type GraphCanvasScope = { scope: NotesGraphScope; hideOrphans?: boolean; days?: boolean };

export type GraphCanvasOptions = {
  // Какие заметки брать; не задана — все. Записывается в холст и действует при обновлении
  scope?: GraphCanvasScope;
  cardWidth?: number;
  cardHeight?: number;
  // Просвет между карточками
  gap?: number;
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
// Поле файла холста (верхний уровень): область, из которой холст собран. Есть только у холстов из графа
export const GRAPH_SCOPE_FIELD = 'pvGraphScope';

const FILE_SUFFIX = '.md';
const PATH_SEPARATOR = '/';
const PAIR_SEPARATOR = '\u0000';
// Поля стрелки, которые есть у любой; остальные со значением не по умолчанию — правка пользователя. Стороны
// карточек своей стрелке ставит движок — правкой они не считаются
const EDGE_OWN_KEYS = ['id', 'fromNode', 'toNode', 'fromSide', 'toSide'];
// Новая карточка ищет место вокруг связанных с ней: шаг — половина клетки, не дальше стольких колец
const SPOT_MAX_RINGS = 240;
// Бюджет сверок «клетка × узел» одного поиска: на плотном поле или с огромным узлом поиск не крутится минутами
const SPOT_MAX_CHECKS = 2_000_000;
// Блок несвязанных заметок встаёт под холстом, если холст заметно шире своей высоты, иначе — справа
const BLOCK_WIDE_RATIO = 2;
const FREE_SPOT_GAP = 40;
const ALL_SCOPE: GraphCanvasScope = { scope: { kind: 'all' } };

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

function uniqueNotes(notes: NotesGraphNote[]) {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
}

function noteCard(note: NotesGraphNote, id: string, at: CanvasPoint, width: number, height: number): CanvasNode {
  return {
    id, type: 'file', x: at.x, y: at.y, width, height, file: `${note.title}${FILE_SUFFIX}`, [GRAPH_NOTE_FIELD]: note.id,
  };
}

function cleanScope(scope?: GraphCanvasScope): GraphCanvasScope {
  if (!scope) return ALL_SCOPE;
  return {
    scope: scope.scope,
    hideOrphans: scope.hideOrphans ? true : undefined,
    days: scope.days === false ? false : undefined,
  };
}

// Область, записанная в холсте; у холста, сделанного руками, её нет
export function scopeOfCanvas(doc: CanvasDoc): GraphCanvasScope | undefined {
  const raw = doc.extra?.[GRAPH_SCOPE_FIELD];
  if (!raw || typeof raw !== 'object') return undefined;
  const { scope, hideOrphans } = parseGraphFilter(raw);
  return cleanScope({ scope, hideOrphans, days: (raw as { days?: unknown }).days === false ? false : undefined });
}

// Холст собран из графа: у него есть «Обновить из графа»
export function isGraphCanvas(doc: CanvasDoc) {
  return Boolean(scopeOfCanvas(doc));
}

function withScope(doc: CanvasDoc, scope: GraphCanvasScope): CanvasDoc {
  return { ...doc, extra: { ...doc.extra, [GRAPH_SCOPE_FIELD]: JSON.parse(JSON.stringify(scope)) } };
}

// Вход движка для холста области: заметки как есть, размеры карточки и сетка холста
function engineInput(notes: NotesGraphNote[], scope: GraphCanvasScope, options: GraphCanvasOptions): NotesGraphInput {
  return {
    notes,
    scope: scope.scope,
    hideOrphans: scope.hideOrphans,
    withDays: scope.days !== false,
    cardWidth: options.cardWidth ?? CANVAS_DEFAULT_NODE_WIDTH,
    cardHeight: options.cardHeight ?? GRAPH_CANVAS_CARD_HEIGHT,
    gap: options.gap ?? GRAPH_CANVAS_GAP,
    grid: CANVAS_GRID,
  };
}

// Холст из заметок области и ссылок между ними. Какие заметки входят, где стоят карточки и с каких сторон
// идут стрелки — ответ движка; здесь карточки (в порядке входа) и стрелки получают идентификаторы. Взаимная
// ссылка — одна стрелка с наконечниками с обеих сторон. Идентификаторы стрелок начинаются с
// `GRAPH_EDGE_PREFIX`, карточка несёт идентификатор своей заметки, область записана в холст.
export function canvasFromGraph(notes: NotesGraphNote[], options: GraphCanvasOptions = {}): CanvasDoc {
  const makeId = options.makeId || newCanvasId;
  const scope = cleanScope(options.scope);
  const shown = uniqueNotes(notes);
  const layout = layoutNotesCanvas(engineInput(shown, scope, options));
  const cardByNote = new Map(layout.cards.map((card) => [card.id, card]));

  const usedIds = new Set<string>();
  const cardIdByNote = new Map<string, string>();
  const cards: CanvasNode[] = [];
  shown.forEach((note) => {
    const card = cardByNote.get(note.id);
    if (!card) return;
    const id = uniqueId(usedIds, makeId);
    cardIdByNote.set(note.id, id);
    cards.push(noteCard(note, id, card, card.width, card.height));
  });

  const edges: CanvasEdge[] = [];
  layout.edges.forEach((edge) => {
    const fromNode = cardIdByNote.get(edge.from);
    const toNode = cardIdByNote.get(edge.to);
    if (!fromNode || !toNode) return;
    edges.push({
      id: uniqueId(usedIds, makeId, GRAPH_EDGE_PREFIX),
      fromNode,
      toNode,
      fromSide: edge.fromSide,
      toSide: edge.toSide,
      fromEnd: edge.mutual ? 'arrow' : undefined,
    });
  });

  return withScope({ nodes: cards, edges }, scope);
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

// Переименованная (либо перенесённая) папка `oldPath` → `newPath`: путь в области холста (папка либо её
// подпапка). Нечего менять — прежний документ
export function renameCanvasFolder(doc: CanvasDoc, oldPath: string, newPath: string): CanvasDoc {
  if (!oldPath || !newPath || oldPath === newPath) return doc;
  const saved = scopeOfCanvas(doc);
  if (saved?.scope.kind !== 'folder' || !isInFolder(saved.scope.folder, oldPath)) return doc;
  const folder = `${newPath}${saved.scope.folder.slice(oldPath.length)}`;
  return withScope(doc, { ...saved, scope: { kind: 'folder', folder } });
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
//    Новые карточки получают только заметки области холста (`scopeOfCanvas`); у холста без области — все.
// 5. Карточка пропавшей заметки остаётся (`missing`). Если она несёт идентификатор заметки, которая теперь
//    называется иначе, карточка перенацеливается на новое название (`renamed`).
// Карточка соответствует заметке по названию (последняя часть пути без `.md`, регистр не важен); у
// одноимённых заметок — по порядку. Совсем пустой холст заполняется раскладкой движка, как новый холст из
// графа. Один вход — один результат.
export function refreshCanvasFromGraph(
  doc: CanvasDoc, notes: NotesGraphNote[], options: GraphCanvasOptions = {},
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

  const scope = scopeOfCanvas(doc) || ALL_SCOPE;

  if (!doc.nodes.length && !doc.edges.length) {
    const built = canvasFromGraph(shown, { ...options, scope });
    if (!built.nodes.length) return result;
    result.doc = { ...doc, nodes: built.nodes, edges: built.edges };
    result.added = { cards: built.nodes.map(({ id }) => id), edges: built.edges.map(({ id }) => id) };
    return result;
  }

  // Какие заметки входят в область холста, решает движок — тем же вызовом, что собирал холст
  const inScope = new Set(layoutNotesCanvas(engineInput(shown, scope, options)).cards.map(({ id }) => id));

  const noteById = new Map(shown.map((note) => [note.id, note]));
  const notesByKey = new Map<string, NotesGraphNote[]>();
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
  const noteOfCard = new Map<string, NotesGraphNote>();
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
  const place = (note: NotesGraphNote, at: CanvasPoint) => {
    const card = noteCard(note, uniqueId(usedIds, makeId), at, width, height);
    addedCards.push(card);
    taken.push(card);
    cardOfNote.set(note.id, card);
    noteOfCard.set(card.id, note);
  };
  let pending = shown.filter((note) => !cardOfNote.has(note.id) && inScope.has(note.id));

  // Сначала те, у кого на холсте уже есть связанная карточка; поставленная карточка сама становится опорой
  for (let hasPlaced = true; hasPlaced && pending.length;) {
    hasPlaced = false;
    const rest: NotesGraphNote[] = [];
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
