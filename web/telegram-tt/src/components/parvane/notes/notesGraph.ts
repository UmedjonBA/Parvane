// Parvane, раздел «Знания»: граф заметок. Чистые функции — сборка узлов и связей из заметок и записей
// планировщика, раскладка Fruchterman–Reingold с гравитацией к центру, соседи узла и его размер.
// Без UI, хранилища и сети.

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

export type GraphEdge = { from: string; to: string };

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
export type GraphOptions = { withDays: boolean; withRecords: boolean };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type GraphLayoutOptions = {
  width: number;
  height: number;
  iterations?: number;
  seed?: number;
  // Отступ от краёв области
  margin?: number;
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

const START_TEMPERATURE = 40;
const COOLING = 0.99;
const START_SPREAD = 300;
const MIN_DISTANCE = 4;

function titleKey(title: string) {
  return title.trim().toLowerCase();
}

function edgeKey(a: string, b: string) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

// Узлы и связи графа. Ссылка на название без заметки даёт один узел `missing` на название (без учёта
// регистра). Ежедневные заметки — только при `withDays`; ссылки на скрытую ежедневную заметку не
// рисуются (она существует, «ещё нет» про неё сказать нельзя). Записи планировщика — только при
// `withRecords` и только те, что ссылаются на заметки; записи с одним названием — один узел
// (повторяющееся событие), их ссылки складываются. Связи без дублей и петель.
export function buildGraph(input: GraphInput, options: GraphOptions): Graph {
  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  const noteIdByTitle = new Map<string, string>();
  const hiddenTitles = new Set<string>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();

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
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ from, to });
    });
  }

  const shownNotes: GraphNoteInput[] = [];
  input.notes.forEach((note) => {
    if ((note.isDaily && !options.withDays) || nodeById.has(note.id)) return;
    addNode(note.id, note.title, note.isDaily ? 'day' : 'note', note.folder);
    shownNotes.push(note);
    // Заметки с одним названием: ссылка ведёт на первую
    const key = titleKey(note.title);
    if (key && !noteIdByTitle.has(key)) noteIdByTitle.set(key, note.id);
  });
  input.notes.forEach((note) => {
    const key = titleKey(note.title);
    if (note.isDaily && !options.withDays && key && !noteIdByTitle.has(key)) hiddenTitles.add(key);
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
  const scale = Math.min(1, spanX > 0 ? roomX / spanX : 1, spanY > 0 ? roomY / spanY : 1);
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
