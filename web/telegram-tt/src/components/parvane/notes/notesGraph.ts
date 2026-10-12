// Parvane, раздел «Знания»: граф заметок. Чистые функции — сборка узлов и связей из заметок и записей
// планировщика, раскладка Fruchterman–Reingold с гравитацией к центру, место новых узлов рядом с уже
// разложенными, соседи узла, его размер, стрелка связи и попадание в узел. Без UI, хранилища и сети.

export type GraphNodeKind = 'note' | 'missing' | 'day' | 'record';

export type GraphNode = {
  // Заметка и ежедневная заметка — id заметки; запись — id первой записи с таким названием;
  // заметка, которой ещё нет, — `missing:<название в нижнем регистре>`
  id: string;
  title: string;
  kind: GraphNodeKind;
  // Папка заметки или тип записи — по нему выбирается цвет
  group?: string;
  // Число разных соседей
  degree: number;
  x: number;
  y: number;
};

// Связь направлена: `from` ссылается на `to`. `isMutual` — есть и обратная ссылка (связь на пару одна)
export type GraphEdge = { from: string; to: string; isMutual?: true };
export type GraphPoint = { x: number; y: number };

export type GraphNoteInput = {
  id: string;
  title: string;
  folder: string;
  // Названия заметок, на которые ссылается эта (`[[ссылки]]`)
  links: string[];
  isDaily?: boolean;
};

export type GraphRecordInput = {
  id: string;
  title: string;
  links: string[];
  // Тип записи (событие, задача…) — попадает в `group` узла
  type?: string;
};

export type GraphInput = { notes: GraphNoteInput[]; records?: GraphRecordInput[] };
export type GraphOptions = {
  withDays: boolean;
  withRecords: boolean;
  // Папки, заметки которых показаны (точное совпадение пути, корень — пустая строка); не задано — все папки.
  // Заметок дней выбор папок не касается: их включает `withDays`
  folders?: readonly string[];
};
// Папка в выборе графа: путь и число обычных заметок в ней
export type GraphFolder = { path: string; count: number };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type GraphLayoutOptions = {
  width: number;
  height: number;
  iterations?: number;
  seed?: number;
  // Отступ от краёв области
  margin?: number;
  // Не сжимать раскладку в область: длина связи остаётся своей, область задаёт только центр (поле графа само
  // масштабируется, а новым узлам нужны те же единицы, что и разложенным)
  isLoose?: boolean;
};

export const MISSING_NODE_PREFIX = 'missing:';

// Константы раскладки — из прототипа; при более слабой гравитации граф разлетается
export const GRAPH_SPRING_LENGTH = 70;
export const GRAPH_GRAVITY = 0.8;
export const GRAPH_ATTRACTION = 0.6;
export const GRAPH_ITERATIONS = 400;
export const GRAPH_DEFAULT_SEED = 1;
export const GRAPH_MARGIN = 24;
// Потолок работы раскладки: число пар узлов × число итераций. До ~500 узлов (124 750 пар) идут все
// 400 итераций; дальше итераций становится меньше во столько же раз, во сколько выросло число пар
// (1000 узлов — 100 итераций, 2000 — 25), но не меньше одной
export const GRAPH_WORK_BUDGET = 50_000_000;

export const GRAPH_MIN_RADIUS = 6;
export const GRAPH_MAX_RADIUS = 28;
// Столько шагов новый узел ищет место среди уже разложенных (те стоят на месте)
export const GRAPH_PLACE_ITERATIONS = 120;
// Длина наконечника стрелки и зазор между связью и кружком
export const GRAPH_ARROW = 7;
export const GRAPH_EDGE_GAP = 3;

const START_TEMPERATURE = 40;
const COOLING = 0.99;
const START_SPREAD = 300;
const MIN_DISTANCE = 4;
const PLACE_TEMPERATURE = 24;
const PLACE_COOLING = 0.97;

function titleKey(title: string) {
  return title.trim().toLowerCase();
}

function edgeKey(a: string, b: string) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

// Заметка видна на графе: заметка дня — при включённых днях, обычная — если её папка выбрана
export function isNoteInGraph(
  note: Pick<GraphNoteInput, 'folder' | 'isDaily'>, options: Pick<GraphOptions, 'withDays' | 'folders'>,
) {
  if (note.isDaily) return options.withDays;
  return !options.folders || options.folders.includes(note.folder);
}

// Папки для выбора на графе: те, где есть обычные заметки (заметки дней папкой не считаются), корень первым,
// дальше по пути
export function listGraphFolders(notes: Pick<GraphNoteInput, 'folder' | 'isDaily'>[]): GraphFolder[] {
  const counts = new Map<string, number>();
  notes.forEach((note) => {
    if (!note.isDaily) counts.set(note.folder, (counts.get(note.folder) || 0) + 1);
  });
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, count]) => ({ path, count }));
}

// Сохранённый выбор папок, приведённый к существующим: исчезнувшие папки выпадают; не осталось ни одной
// либо выбраны все — это «все папки» (`undefined`)
export function resolveGraphFolders(saved: readonly string[] | undefined, known: GraphFolder[]) {
  if (!saved) return undefined;
  const kept = known.filter(({ path }) => saved.includes(path)).map(({ path }) => path);
  return kept.length && kept.length < known.length ? kept : undefined;
}

// Узлы и связи графа. Ссылка на название без заметки даёт один узел `missing` на название (без учёта
// регистра). Ежедневные заметки — только при `withDays`, обычные — только из выбранных папок (`folders`);
// ссылки на скрытую заметку не рисуются (она существует, «ещё нет» про неё сказать нельзя), так что соседей
// из невыбранных папок на графе нет. Записи планировщика — только при
// `withRecords` и только те, что ссылаются на заметки; записи с одним названием — один узел
// (повторяющееся событие), их ссылки складываются. Связи без дублей и петель: на пару узлов одна связь
// в сторону первой найденной ссылки, встречная ссылка помечает её `isMutual`.
export function buildGraph(input: GraphInput, options: GraphOptions): Graph {
  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  const noteIdByTitle = new Map<string, string>();
  const hiddenTitles = new Set<string>();
  const edges: GraphEdge[] = [];
  const edgeByKey = new Map<string, GraphEdge>();

  function addNode(id: string, title: string, kind: GraphNodeKind, group?: string) {
    const node: GraphNode = {
      id, title, kind, ...(group !== undefined && { group }), degree: 0, x: 0, y: 0,
    };
    nodes.push(node);
    nodeById.set(id, node);
  }

  function resolveTarget(link: string) {
    const key = titleKey(link);
    if (!key || hiddenTitles.has(key)) return undefined;
    const noteId = noteIdByTitle.get(key);
    if (noteId !== undefined) return noteId;
    const id = MISSING_NODE_PREFIX + key;
    if (!nodeById.has(id)) addNode(id, link.trim(), 'missing');
    return id;
  }

  function connect(from: string, links: string[]) {
    links.forEach((link) => {
      const to = resolveTarget(link);
      if (to === undefined || to === from) return;
      const key = edgeKey(from, to);
      const known = edgeByKey.get(key);
      if (known) {
        if (known.from === to) known.isMutual = true;
        return;
      }
      const edge: GraphEdge = { from, to };
      edgeByKey.set(key, edge);
      edges.push(edge);
    });
  }

  const shownNotes: GraphNoteInput[] = [];
  input.notes.forEach((note) => {
    if (!isNoteInGraph(note, options) || nodeById.has(note.id)) return;
    addNode(note.id, note.title, note.isDaily ? 'day' : 'note', note.folder);
    shownNotes.push(note);
    // Заметки с одним названием: ссылка ведёт на первую
    const key = titleKey(note.title);
    if (key && !noteIdByTitle.has(key)) noteIdByTitle.set(key, note.id);
  });
  input.notes.forEach((note) => {
    const key = titleKey(note.title);
    if (!isNoteInGraph(note, options) && key && !noteIdByTitle.has(key)) hiddenTitles.add(key);
  });
  shownNotes.forEach((note) => connect(note.id, note.links));

  if (options.withRecords) {
    const recordIdByTitle = new Map<string, string>();
    (input.records || []).forEach((record) => {
      if (!record.links.some((link) => {
        const key = titleKey(link);
        return key && !hiddenTitles.has(key);
      })) return;
      const key = titleKey(record.title);
      let id = recordIdByTitle.get(key);
      if (id === undefined) {
        // Запись с id уже занятого узла пропускается: два узла с одним id различить нельзя
        if (nodeById.has(record.id)) return;
        id = record.id;
        recordIdByTitle.set(key, id);
        addNode(id, record.title, 'record', record.type);
      }
      connect(id, record.links);
    });
  }

  edges.forEach((edge) => {
    nodeById.get(edge.from)!.degree++;
    nodeById.get(edge.to)!.degree++;
  });

  return { nodes, edges };
}

// Генератор псевдослучайных чисел с зерном (mulberry32): одна и та же раскладка при одном зерне
export function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Сколько итераций реально пройдёт раскладка для графа из `nodeCount` узлов (см. GRAPH_WORK_BUDGET)
export function getLayoutIterations(nodeCount: number, requested = GRAPH_ITERATIONS) {
  const wanted = Math.max(0, Math.floor(Number.isFinite(requested) ? requested : GRAPH_ITERATIONS));
  const pairs = (nodeCount * (nodeCount - 1)) / 2;
  if (pairs <= 0 || wanted === 0) return wanted;
  return Math.min(wanted, Math.max(1, Math.floor(GRAPH_WORK_BUDGET / pairs)));
}

// Раскладка Fruchterman–Reingold с гравитацией к центру. Возвращает копии узлов в прежнем порядке с
// новыми `x`/`y` внутри области `width` × `height` с отступом `margin`: раскладка считается в своих
// единицах (длина связи 70), затем центрируется и, если не помещается, равномерно сжимается.
// Результат зависит только от входа и зерна. Связи с неизвестными узлами и петли игнорируются.
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], options: GraphLayoutOptions): GraphNode[] {
  const count = nodes.length;
  if (!count) return [];

  const width = Math.max(0, options.width || 0);
  const height = Math.max(0, options.height || 0);
  const centerX = width / 2;
  const centerY = height / 2;
  if (count === 1) return [{ ...nodes[0], x: centerX, y: centerY }];

  const random = createSeededRandom(options.seed ?? GRAPH_DEFAULT_SEED);
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    px[i] = (random() * 2 - 1) * START_SPREAD;
    py[i] = (random() * 2 - 1) * START_SPREAD;
  }

  const indexById = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!indexById.has(node.id)) indexById.set(node.id, i);
  });
  const links: [number, number][] = [];
  edges.forEach((edge) => {
    const a = indexById.get(edge.from);
    const b = indexById.get(edge.to);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  });

  const iterations = getLayoutIterations(count, options.iterations);
  // При урезанном числе итераций остывание идёт быстрее и заканчивается на той же температуре
  const cooling = iterations ? COOLING ** (GRAPH_ITERATIONS / Math.max(iterations, 1)) : COOLING;
  const k2 = GRAPH_SPRING_LENGTH * GRAPH_SPRING_LENGTH;
  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  let temperature = START_TEMPERATURE;

  for (let step = 0; step < iterations; step++, temperature *= cooling) {
    for (let i = 0; i < count; i++) {
      fx[i] = -px[i] * GRAPH_GRAVITY;
      fy[i] = -py[i] * GRAPH_GRAVITY;
    }
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        if (dx === 0 && dy === 0) {
          // Совпавшие точки расталкиваются в направлении, заданном их номерами
          dx = 0.01 * (j - i);
          dy = 0.01;
        }
        const distance = Math.max(MIN_DISTANCE, Math.hypot(dx, dy));
        const force = k2 / (distance * distance);
        fx[i] += dx * force;
        fy[i] += dy * force;
        fx[j] -= dx * force;
        fy[j] -= dy * force;
      }
    }
    for (let e = 0; e < links.length; e++) {
      const [a, b] = links[e];
      const dx = px[a] - px[b];
      const dy = py[a] - py[b];
      const distance = Math.max(MIN_DISTANCE, Math.hypot(dx, dy));
      const force = (distance / GRAPH_SPRING_LENGTH) * GRAPH_ATTRACTION;
      fx[a] -= dx * force;
      fy[a] -= dy * force;
      fx[b] += dx * force;
      fy[b] += dy * force;
    }
    for (let i = 0; i < count; i++) {
      const length = Math.max(1, Math.hypot(fx[i], fy[i]));
      const limited = Math.min(length, temperature) / length;
      px[i] += fx[i] * limited;
      py[i] += fy[i] * limited;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, px[i]);
    maxX = Math.max(maxX, px[i]);
    minY = Math.min(minY, py[i]);
    maxY = Math.max(maxY, py[i]);
  }
  const margin = Math.max(0, options.margin ?? GRAPH_MARGIN);
  const roomX = Math.max(0, width - margin * 2);
  const roomY = Math.max(0, height - margin * 2);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = options.isLoose ? 1 : Math.min(1, spanX > 0 ? roomX / spanX : 1, spanY > 0 ? roomY / spanY : 1);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  return nodes.map((node, i) => ({
    ...node,
    x: centerX + (px[i] - midX) * scale,
    y: centerY + (py[i] - midY) * scale,
  }));
}

// Соседи узла (сам узел не входит) — для подсветки по тапу
export function neighboursOf(nodeId: string, edges: GraphEdge[]) {
  const result = new Set<string>();
  edges.forEach((edge) => {
    if (edge.from === nodeId && edge.to !== nodeId) result.add(edge.to);
    if (edge.to === nodeId && edge.from !== nodeId) result.add(edge.from);
  });
  return result;
}

// Радиус точки по числу связей: 6 у одиночки, растёт как корень, не больше 28
export function nodeRadius(degree: number) {
  const safe = Number.isFinite(degree) ? Math.max(0, degree) : 0;
  return Math.min(GRAPH_MAX_RADIUS, GRAPH_MIN_RADIUS + Math.sqrt(safe) * 3.2);
}

// Раскладка, которая не перетряхивает граф при малом изменении: узлы, у которых есть прежнее место (`previous`),
// остаются ровно на нём, место ищут только новые — рядом с уже стоящими соседями (без соседей — с краю), теми же
// силами, что и в полной раскладке. Заметка, созданная на месте «заметки, которой ещё нет», занимает её место.
// Прежних мест нет ни у одного узла — полная раскладка `layoutGraph`.
export function placeGraph(
  nodes: GraphNode[], edges: GraphEdge[], previous: ReadonlyMap<string, GraphPoint>, options: GraphLayoutOptions,
): GraphNode[] {
  const count = nodes.length;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const free: number[] = [];
  let sumX = 0;
  let sumY = 0;
  nodes.forEach((node, i) => {
    const at = previous.get(node.id)
      || (node.kind === 'note' || node.kind === 'day'
        ? previous.get(MISSING_NODE_PREFIX + titleKey(node.title)) : undefined);
    if (!at) {
      free.push(i);
      return;
    }
    px[i] = at.x;
    py[i] = at.y;
    sumX += at.x;
    sumY += at.y;
  });
  const known = count - free.length;
  if (!known) return layoutGraph(nodes, edges, options);
  const place = () => nodes.map((node, i) => ({ ...node, x: px[i], y: py[i] }));
  if (!free.length) return place();

  const centerX = sumX / known;
  const centerY = sumY / known;
  const isPlaced = new Uint8Array(count).fill(1);
  free.forEach((i) => {
    isPlaced[i] = 0;
  });
  let reach = 0;
  for (let i = 0; i < count; i++) {
    if (isPlaced[i]) reach = Math.max(reach, Math.hypot(px[i] - centerX, py[i] - centerY));
  }

  const indexById = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!indexById.has(node.id)) indexById.set(node.id, i);
  });
  const linked: number[][] = nodes.map(() => []);
  edges.forEach((edge) => {
    const a = indexById.get(edge.from);
    const b = indexById.get(edge.to);
    if (a === undefined || b === undefined || a === b) return;
    linked[a].push(b);
    linked[b].push(a);
  });

  // Начальное место: на длину связи от середины стоящих соседей, в сторону от центра графа
  const random = createSeededRandom(options.seed ?? GRAPH_DEFAULT_SEED);
  free.forEach((i) => {
    const around = linked[i].filter((j) => isPlaced[j]);
    const angle = random() * Math.PI * 2;
    let baseX = centerX;
    let baseY = centerY;
    let distance = reach + GRAPH_SPRING_LENGTH;
    let dirX = Math.cos(angle);
    let dirY = Math.sin(angle);
    if (around.length) {
      baseX = around.reduce((sum, j) => sum + px[j], 0) / around.length;
      baseY = around.reduce((sum, j) => sum + py[j], 0) / around.length;
      distance = GRAPH_SPRING_LENGTH;
      const away = Math.hypot(baseX - centerX, baseY - centerY);
      if (away > MIN_DISTANCE) {
        dirX = (baseX - centerX) / away;
        dirY = (baseY - centerY) / away;
      }
    }
    px[i] = baseX + dirX * distance;
    py[i] = baseY + dirY * distance;
    isPlaced[i] = 1;
  });

  const k2 = GRAPH_SPRING_LENGTH * GRAPH_SPRING_LENGTH;
  const iterations = Math.max(0, Math.floor(options.iterations ?? GRAPH_PLACE_ITERATIONS));
  let temperature = PLACE_TEMPERATURE;
  for (let step = 0; step < iterations; step++, temperature *= PLACE_COOLING) {
    for (let f = 0; f < free.length; f++) {
      const i = free[f];
      let fx = (centerX - px[i]) * GRAPH_GRAVITY;
      let fy = (centerY - py[i]) * GRAPH_GRAVITY;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        if (dx === 0 && dy === 0) {
          dx = 0.01 * (i - j);
          dy = 0.01;
        }
        const distance = Math.max(MIN_DISTANCE, Math.hypot(dx, dy));
        const force = k2 / (distance * distance);
        fx += dx * force;
        fy += dy * force;
      }
      for (let n = 0; n < linked[i].length; n++) {
        const j = linked[i][n];
        const dx = px[i] - px[j];
        const dy = py[i] - py[j];
        const force = (Math.max(MIN_DISTANCE, Math.hypot(dx, dy)) / GRAPH_SPRING_LENGTH) * GRAPH_ATTRACTION;
        fx -= dx * force;
        fy -= dy * force;
      }
      const length = Math.max(1, Math.hypot(fx, fy));
      const limited = Math.min(length, temperature) / length;
      px[i] += fx * limited;
      py[i] += fy * limited;
    }
  }
  return place();
}

// Узел под точкой поля (ближайший из тех, в чей кружок с запасом `slop` она попала)
export function nodeAt(nodes: GraphNode[], x: number, y: number, slop = 0) {
  let found: GraphNode | undefined;
  let best = Infinity;
  nodes.forEach((node) => {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= nodeRadius(node.degree) + slop && distance < best) {
      best = distance;
      found = node;
    }
  });
  return found;
}

// Связь проводят от заметки (у неё есть текст, куда пишется ссылка) к заметке — существующей либо той, которой
// ещё нет. Заметки дней и записи «Плана» в правке связей не участвуют
export function canLinkFrom(node?: Pick<GraphNode, 'kind'>) {
  return node?.kind === 'note';
}

export function canLinkTo(node?: Pick<GraphNode, 'kind'>) {
  return node?.kind === 'note' || node?.kind === 'missing';
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function arrowHead(tipX: number, tipY: number, ux: number, uy: number) {
  const backX = tipX - ux * GRAPH_ARROW;
  const backY = tipY - uy * GRAPH_ARROW;
  const wing = GRAPH_ARROW * 0.5;
  return `M${round(tipX)} ${round(tipY)}L${round(backX - uy * wing)} ${round(backY + ux * wing)}`
    + `L${round(backX + uy * wing)} ${round(backY - ux * wing)}Z`;
}

// Линия связи от края кружка до края кружка и наконечники: у `to`, при взаимной ссылке — и у `from`.
// Кружки вплотную — линия от центра к центру без наконечников
export function edgeShape(
  from: GraphPoint, to: GraphPoint, fromRadius: number, toRadius: number, isMutual?: boolean,
) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (length <= fromRadius + toRadius + GRAPH_EDGE_GAP * 2 + GRAPH_ARROW) {
    return {
      x1: round(from.x), y1: round(from.y), x2: round(to.x), y2: round(to.y), heads: [] as string[], middle,
    };
  }
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const x1 = from.x + ux * (fromRadius + GRAPH_EDGE_GAP);
  const y1 = from.y + uy * (fromRadius + GRAPH_EDGE_GAP);
  const x2 = to.x - ux * (toRadius + GRAPH_EDGE_GAP);
  const y2 = to.y - uy * (toRadius + GRAPH_EDGE_GAP);
  const heads = [arrowHead(x2, y2, ux, uy)];
  if (isMutual) heads.push(arrowHead(x1, y1, -ux, -uy));
  return {
    x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2), heads, middle,
  };
}
