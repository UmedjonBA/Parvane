// Parvane, раздел «Знания»: холст в открытом формате JSON Canvas (файлы `.canvas`). Чистые функции —
// разбор и запись файла, правки документа (каждая возвращает новый документ), геометрия вида и стрелок.
// Без UI, хранилища и сети.

export type CanvasNodeType = 'text' | 'file' | 'group' | 'link';
export type CanvasPresetColor = '1' | '2' | '3' | '4' | '5' | '6';
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';

export const CANVAS_NODE_TYPES: CanvasNodeType[] = ['text', 'file', 'group', 'link'];
export const CANVAS_PRESET_COLORS: CanvasPresetColor[] = ['1', '2', '3', '4', '5', '6'];
export const CANVAS_SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left'];

// Узел холста. `type` и `color` — строки: файл из другого приложения может нести незнакомый тип узла
// или цвет в виде `#rrggbb`, и то и другое сохраняется как есть. Известные значения — `CanvasNodeType`
// и `CanvasPresetColor` (проверки `isCanvasNodeType`, `isCanvasPresetColor`). Незнакомые поля лежат
// в самом объекте и переживают запись.
export type CanvasNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  // text
  text?: string;
  // file: путь (у нас — название заметки) и якорь внутри файла
  file?: string;
  subpath?: string;
  // link
  url?: string;
  // group
  label?: string;
  background?: string;
  backgroundStyle?: string;
  [key: string]: unknown;
};

export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toEnd?: CanvasEnd;
  label?: string;
  color?: string;
  [key: string]: unknown;
};

export type CanvasDoc = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  // Незнакомые поля верхнего уровня файла — сохраняются при записи
  extra?: Record<string, unknown>;
};

// `json` — текст не разобрать; `shape` — это не объект холста (`nodes` или `edges` есть, но не массив)
export type CanvasParseError = 'json' | 'shape';

export type CanvasParseResult = {
  doc: CanvasDoc;
  error?: CanvasParseError;
  // Сколько узлов и связей выброшено: без id, без типа или концов, с повторным id
  dropped: { nodes: number; edges: number };
};

export type CanvasPoint = { x: number; y: number };
export type CanvasRect = { x: number; y: number; width: number; height: number };
export type CanvasViewport = { width: number; height: number };
// Вид: экранная точка = точка холста × scale + (x, y)
export type CanvasView = { scale: number; x: number; y: number };
export type CanvasAnchor = CanvasPoint & { side: CanvasSide };

export const CANVAS_DEFAULT_NODE_WIDTH = 250;
export const CANVAS_DEFAULT_NODE_HEIGHT = 60;
export const CANVAS_MIN_SCALE = 0.15;
export const CANVAS_MAX_SCALE = 2.5;
// «Вписать» не приближает сильнее этого
export const CANVAS_FIT_MAX_SCALE = 1.2;
export const CANVAS_FIT_PADDING = 40;

const NODE_HEAD_KEYS = ['id', 'type', 'x', 'y', 'width', 'height'];
const NODE_KNOWN_KEYS = [
  ...NODE_HEAD_KEYS, 'color', 'text', 'file', 'subpath', 'url', 'label', 'background', 'backgroundStyle',
];
const EDGE_KNOWN_KEYS = ['id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label'];
const HEX = '0123456789abcdef';

export function isCanvasNodeType(type: string): type is CanvasNodeType {
  return (CANVAS_NODE_TYPES as string[]).includes(type);
}

export function isCanvasPresetColor(color: string | undefined): color is CanvasPresetColor {
  return color !== undefined && (CANVAS_PRESET_COLORS as string[]).includes(color);
}

export function createEmptyCanvas(): CanvasDoc {
  return { nodes: [], edges: [] };
}

// Идентификатор узла или связи: 16 шестнадцатеричных знаков. `random` — источник чисел [0, 1)
export function newCanvasId(random: () => number = Math.random) {
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += HEX[Math.min(15, Math.max(0, Math.floor(random() * 16)))];
  }
  return id;
}

// ── разбор и запись ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && Boolean(value) && !Array.isArray(value);
}

function toId(value: unknown) {
  if (typeof value === 'string') return value || undefined;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/** Адрес карточки-ссылки: только http(s); прочие схемы (javascript:, data: …) ссылкой не становятся */
export function isSafeCanvasUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function toNumber(value: unknown, fallback: number) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSize(value: unknown, fallback: number) {
  const parsed = toNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

// Разбор файла `.canvas`. Терпимый: незнакомые типы узлов и незнакомые поля сохраняются, числа
// приводятся (нет или не число — 0 для координат, 250 × 60 для размера), узлы без id или типа и связи
// без id или концов выбрасываются и считаются в `dropped`. Пустой файл и `{}` — пустой холст без
// ошибки (так выглядит новый холст); нет одного из массивов — он считается пустым. Нечитаемый JSON
// и не-объект дают пустой документ и `error`.
export function parseCanvas(text: string): CanvasParseResult {
  const dropped = { nodes: 0, edges: 0 };
  if (!text.trim()) return { doc: createEmptyCanvas(), dropped };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { doc: createEmptyCanvas(), error: 'json', dropped };
  }
  if (!isRecord(raw)) return { doc: createEmptyCanvas(), error: 'shape', dropped };
  const { nodes: rawNodes = [], edges: rawEdges = [], ...rest } = raw;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
    return { doc: createEmptyCanvas(), error: 'shape', dropped };
  }

  const nodes: CanvasNode[] = [];
  const nodeIds = new Set<string>();
  rawNodes.forEach((item: unknown) => {
    const id = isRecord(item) ? toId(item.id) : undefined;
    if (!isRecord(item) || id === undefined || typeof item.type !== 'string' || !item.type || nodeIds.has(id)) {
      dropped.nodes++;
      return;
    }
    nodeIds.add(id);
    // Негодный адрес карточки-ссылки из чужого файла/вставки отбрасывается: карточка рисуется без ссылки
    const isBadUrl = item.type === 'link' && 'url' in item && !isSafeCanvasUrl(item.url);
    const safe = isBadUrl ? { ...item, url: undefined } : item;
    nodes.push({
      ...safe,
      id,
      type: item.type,
      x: toNumber(item.x, 0),
      y: toNumber(item.y, 0),
      width: toSize(item.width, CANVAS_DEFAULT_NODE_WIDTH),
      height: toSize(item.height, CANVAS_DEFAULT_NODE_HEIGHT),
    });
  });

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  rawEdges.forEach((item: unknown) => {
    const id = isRecord(item) ? toId(item.id) : undefined;
    const fromNode = isRecord(item) ? toId(item.fromNode) : undefined;
    const toNode = isRecord(item) ? toId(item.toNode) : undefined;
    if (!isRecord(item) || id === undefined || fromNode === undefined || toNode === undefined || edgeIds.has(id)) {
      dropped.edges++;
      return;
    }
    edgeIds.add(id);
    edges.push({
      ...item, id, fromNode, toNode,
    });
  });

  const doc: CanvasDoc = { nodes, edges };
  if (Object.keys(rest).length) doc.extra = rest;
  return { doc, dropped };
}

function orderKeys(source: Record<string, unknown>, knownKeys: string[]) {
  const result: Record<string, unknown> = {};
  knownKeys.forEach((key) => {
    if (source[key] !== undefined) result[key] = source[key];
  });
  Object.keys(source).filter((key) => !knownKeys.includes(key)).sort().forEach((key) => {
    if (source[key] !== undefined) result[key] = source[key];
  });
  return result;
}

// Запись файла `.canvas`: JSON с отступом табуляцией (как пишет Obsidian) и постоянным порядком
// ключей — `nodes`, `edges`, прочее; в узле id, type, геометрия, известные поля, незнакомые по
// алфавиту; в связи id, начало, конец, цвет, подпись, незнакомые по алфавиту. Повторная запись того же
// документа даёт тот же текст.
export function serializeCanvas(doc: CanvasDoc) {
  const extra = doc.extra || {};
  const out: Record<string, unknown> = {
    nodes: doc.nodes.map((node) => orderKeys(node, NODE_KNOWN_KEYS)),
    edges: doc.edges.map((edge) => orderKeys(edge, EDGE_KNOWN_KEYS)),
  };
  Object.keys(extra).filter((key) => key !== 'nodes' && key !== 'edges').sort().forEach((key) => {
    if (extra[key] !== undefined) out[key] = extra[key];
  });
  return JSON.stringify(out, undefined, '\t');
}

// ── правки ───────────────────────────────────────────────────────────────────

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {};
  Object.keys(value).forEach((key) => {
    if (value[key] !== undefined) result[key] = value[key];
  });
  return result as T;
}

export function findNode(doc: CanvasDoc, id: string) {
  return doc.nodes.find((node) => node.id === id);
}

// Новый узел в конце списка (в JSON Canvas порядок узлов — порядок слоёв). Узел с занятым id не
// добавляется — возвращается прежний документ
export function addNode(doc: CanvasDoc, node: CanvasNode): CanvasDoc {
  if (!node.id || findNode(doc, node.id)) return doc;
  return { ...doc, nodes: [...doc.nodes, withoutUndefined(node)] };
}

// Правка полей узла; `undefined` в `patch` убирает поле (например, цвет). `id` не меняется
export function updateNode(doc: CanvasDoc, id: string, patch: Partial<CanvasNode>): CanvasDoc {
  if (!findNode(doc, id)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === id ? withoutUndefined({ ...node, ...patch, id }) : node)),
  };
}

// Удаление узла вместе с его связями. Содержимое удалённой группы остаётся на месте
export function removeNode(doc: CanvasDoc, id: string): CanvasDoc {
  if (!findNode(doc, id)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => node.id !== id),
    edges: doc.edges.filter((edge) => edge.fromNode !== id && edge.toNode !== id),
  };
}

// Стрелка от `from` к `to`. Не добавляется (возвращается прежний документ): петля, нет одного из узлов,
// такая стрелка в том же направлении уже есть. Обратная стрелка — отдельная связь
export function addEdge(
  doc: CanvasDoc, from: string, to: string, label?: string, makeId: () => string = newCanvasId,
): CanvasDoc {
  if (from === to || !findNode(doc, from) || !findNode(doc, to)) return doc;
  if (doc.edges.some((edge) => edge.fromNode === from && edge.toNode === to)) return doc;
  let id = makeId();
  for (let attempt = 0; attempt < 8 && doc.edges.some((edge) => edge.id === id); attempt++) {
    id = makeId();
  }
  if (!id || doc.edges.some((edge) => edge.id === id)) return doc;
  const edge: CanvasEdge = { id, fromNode: from, toNode: to };
  if (label) edge.label = label;
  return { ...doc, edges: [...doc.edges, edge] };
}

// Правка связи (подпись, цвет, стороны); `undefined` и пустая подпись убирают поле. Концы и id не меняются
export function updateEdge(doc: CanvasDoc, id: string, patch: Partial<CanvasEdge>): CanvasDoc {
  if (!doc.edges.some((edge) => edge.id === id)) return doc;
  return {
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      const next = {
        ...edge, ...patch, id, fromNode: edge.fromNode, toNode: edge.toNode,
      };
      if (next.label === '') next.label = undefined;
      return withoutUndefined(next);
    }),
  };
}

export function removeEdge(doc: CanvasDoc, id: string): CanvasDoc {
  if (!doc.edges.some((edge) => edge.id === id)) return doc;
  return { ...doc, edges: doc.edges.filter((edge) => edge.id !== id) };
}

function isInside(inner: CanvasRect, outer: CanvasRect) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

// Узлы, чей прямоугольник целиком лежит внутри группы (касание границы считается; вложенные группы
// входят). Сама группа не входит; для не-группы — пусто
export function nodesInGroup(doc: CanvasDoc, groupId: string): CanvasNode[] {
  const group = findNode(doc, groupId);
  if (!group || group.type !== 'group') return [];
  return doc.nodes.filter((node) => node !== group && isInside(node, group));
}

// Сдвиг узла на (dx, dy); координаты округляются до целых. Группа тянет за собой всё, что на момент
// сдвига лежит внутри неё целиком
export function moveNode(doc: CanvasDoc, id: string, dx: number, dy: number): CanvasDoc {
  if (!findNode(doc, id) || (!dx && !dy)) return doc;
  const moving = new Set([id, ...nodesInGroup(doc, id).map((node) => node.id)]);
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (
      moving.has(node.id) ? { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) } : node
    )),
  };
}

// ── геометрия ────────────────────────────────────────────────────────────────

export function boundsOfRects(rects: CanvasRect[]): CanvasRect | undefined {
  if (!rects.length) return undefined;
  // Циклом, не Math.min(...): spread сотен тысяч аргументов бросает RangeError
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rect of rects) {
    if (rect.x < x0) x0 = rect.x;
    if (rect.y < y0) y0 = rect.y;
    if (rect.x + rect.width > x1) x1 = rect.x + rect.width;
    if (rect.y + rect.height > y1) y1 = rect.y + rect.height;
  }
  return {
    x: x0, y: y0, width: x1 - x0, height: y1 - y0,
  };
}

// Прямоугольник, охватывающий все узлы; у пустого холста его нет
export function boundsOf(doc: CanvasDoc): CanvasRect | undefined {
  return boundsOfRects(doc.nodes);
}

export function clampCanvasScale(scale: number) {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

// Вид, в котором `bounds` целиком помещается в окно с полями `padding` и стоит по центру. Масштаб не
// больше 1,2 и в пределах 0,15…2,5. Без `bounds` (пустой холст) — масштаб 1, начало координат в центре
export function fitView(
  bounds: CanvasRect | undefined, viewport: CanvasViewport, padding = CANVAS_FIT_PADDING,
): CanvasView {
  if (!bounds) return { scale: 1, x: viewport.width / 2, y: viewport.height / 2 };
  const roomX = Math.max(1, viewport.width - padding * 2);
  const roomY = Math.max(1, viewport.height - padding * 2);
  const scale = clampCanvasScale(Math.min(
    bounds.width > 0 ? roomX / bounds.width : Infinity,
    bounds.height > 0 ? roomY / bounds.height : Infinity,
    CANVAS_FIT_MAX_SCALE,
  ));
  return {
    scale,
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * scale,
  };
}

// Вид для телефона: крупно первая группа (первая по порядку в файле); групп нет — весь холст
export function firstGroupView(
  doc: CanvasDoc, viewport: CanvasViewport, padding = CANVAS_FIT_PADDING,
): CanvasView {
  const group = doc.nodes.find((node) => node.type === 'group');
  return fitView(group ? boundsOfRects([group]) : boundsOf(doc), viewport, padding);
}

function sideToward(from: CanvasRect, to: CanvasRect): CanvasSide {
  const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
  const dy = (to.y + to.height / 2) - (from.y + from.height / 2);
  // Сравнение с диагональю прямоугольника: луч к центру соседа выходит через эту сторону
  if (Math.abs(dx) * from.height > Math.abs(dy) * from.width) return dx > 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

// Середина стороны прямоугольника
export function sidePoint(rect: CanvasRect, side: CanvasSide): CanvasPoint {
  switch (side) {
    case 'top': return { x: rect.x + rect.width / 2, y: rect.y };
    case 'bottom': return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'left': return { x: rect.x, y: rect.y + rect.height / 2 };
    default: return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

// Две точки на границах узлов, которые соединяет стрелка: середины сторон. Сторона берётся из
// `sides` (поля связи `fromSide`/`toSide`), а если её нет — по взаимному положению узлов
export function edgeAnchors(
  fromNode: CanvasRect, toNode: CanvasRect, sides?: { fromSide?: CanvasSide; toSide?: CanvasSide },
): { from: CanvasAnchor; to: CanvasAnchor } {
  const pick = (side: CanvasSide | undefined, fallback: CanvasSide) => (
    side && CANVAS_SIDES.includes(side) ? side : fallback
  );
  const fromSide = pick(sides?.fromSide, sideToward(fromNode, toNode));
  const toSide = pick(sides?.toSide, sideToward(toNode, fromNode));
  return {
    from: { ...sidePoint(fromNode, fromSide), side: fromSide },
    to: { ...sidePoint(toNode, toSide), side: toSide },
  };
}
