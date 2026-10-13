import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphInput, GraphNode } from './notesGraph';

import {
  buildGraph, canLinkFrom, canLinkTo, createSeededRandom, edgeShape, getLayoutIterations, getPlaceIterations,
  GRAPH_ARROW, GRAPH_EDGE_GAP, GRAPH_GRID_FROM, GRAPH_ITERATIONS, GRAPH_MARGIN, GRAPH_MAX_RADIUS, GRAPH_MIN_RADIUS,
  GRAPH_PLACE_ITERATIONS, GRAPH_PLACE_WORK_BUDGET, GRAPH_SPRING_LENGTH, GRAPH_WORK_BUDGET, isNoteInGraph, layoutGraph,
  listGraphFolders, neighboursOf, nodeAt, nodeRadius, placeGraph, resolveGraphFolders, startGraphLayout,
} from './notesGraph';

const ALL = { withDays: true, withRecords: true };
const NOTES_ONLY = { withDays: false, withRecords: false };

const INPUT: GraphInput = {
  notes: [
    { id: 'n1', title: 'Проект Парванэ', folder: 'Работа', links: ['Протокол v2', 'Идеи', 'идеи', 'Проект Парванэ'] },
    { id: 'n2', title: 'Протокол v2', folder: 'Работа', links: ['проект парванэ', 'Sealed sender'] },
    { id: 'n3', title: 'Идеи', folder: 'Личное', links: [] },
    { id: 'n4', title: 'Одиночка', folder: 'Личное', links: [] },
    {
      id: 'd1', title: '2026-10-12', folder: 'Дни', links: ['Идеи', 'SEALED SENDER'], isDaily: true,
    },
  ],
  records: [
    {
      id: 'r1', title: 'Созвон по проекту', links: ['Проект Парванэ'], type: 'event',
    },
    {
      id: 'r2', title: 'Созвон по проекту', links: ['Протокол v2', 'Проект Парванэ'], type: 'event',
    },
    {
      id: 'r3', title: 'Написать спеку', links: ['Протокол v2', 'Черновик спеки'], type: 'task',
    },
    {
      id: 'r4', title: 'Без ссылок', links: [], type: 'task',
    },
  ],
};

function node(nodes: GraphNode[], id: string) {
  const found = nodes.find((item) => item.id === id);
  if (!found) throw new Error(`нет узла ${id}`);
  return found;
}

function pairs(edges: GraphEdge[]) {
  return edges.map((edge) => [edge.from, edge.to].sort().join(' — ')).sort();
}

// Случайное дерево с лишними связями на `count` узлов — синтетика большого графа
function synth(count: number, seed = 3): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const random = createSeededRandom(seed);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `n${i}`, title: `Заметка ${i}`, kind: 'note', degree: 0, x: 0, y: 0,
    });
  }
  for (let i = 1; i < count; i++) {
    edges.push({ from: `n${i}`, to: `n${Math.floor(random() * i)}` });
    if (random() < 0.5) edges.push({ from: `n${i}`, to: `n${Math.floor(random() * i)}` });
  }
  const degree = new Map<string, number>();
  edges.forEach((edge) => {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  });
  nodes.forEach((item) => {
    item.degree = degree.get(item.id) || 0;
  });
  return { nodes, edges };
}

// Доля пар узлов, чьи кружки наложились, — простая метрика качества раскладки
function overlapShare(nodes: GraphNode[]) {
  let bad = 0;
  let total = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      total++;
      const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (distance < nodeRadius(nodes[i].degree) + nodeRadius(nodes[j].degree)) bad++;
    }
  }
  return bad / total;
}

function chain(count: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `n${i}`, title: `Заметка ${i}`, kind: 'note', degree: 0, x: 0, y: 0,
    });
    if (i) edges.push({ from: `n${i - 1}`, to: `n${i}` });
  }
  return { nodes, edges };
}

// Раскладка синтетических графов в сотни узлов под нагрузкой полного прогона не укладывается в 5 с по умолчанию
const HEAVY_TIMEOUT_MS = 60_000;

describe('граф заметок: сборка', () => {
  it('только заметки: узлы, недостающие заметки, связи без дублей и петель', () => {
    const graph = buildGraph(INPUT, NOTES_ONLY);
    expect(graph.nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'missing:sealed sender']);
    expect(pairs(graph.edges)).toEqual([
      'missing:sealed sender — n2',
      'n1 — n2',
      'n1 — n3',
    ]);
    expect(node(graph.nodes, 'n1')).toEqual({
      id: 'n1', title: 'Проект Парванэ', kind: 'note', group: 'Работа', degree: 2, x: 0, y: 0,
    });
  });

  it('недостающая заметка — один узел на название без учёта регистра, название как в первой ссылке', () => {
    const graph = buildGraph(INPUT, ALL);
    const missing = graph.nodes.filter((item) => item.kind === 'missing');
    expect(missing.map((item) => item.title)).toEqual(['Sealed sender', 'Черновик спеки']);
    expect(node(graph.nodes, 'missing:sealed sender').degree).toBe(2);
    expect(node(graph.nodes, 'missing:sealed sender').group).toBeUndefined();
  });

  it('ежедневные заметки — только с фильтром «Дни»', () => {
    const graph = buildGraph(INPUT, { withDays: true, withRecords: false });
    expect(node(graph.nodes, 'd1')).toMatchObject({ kind: 'day', group: 'Дни', degree: 2 });
    expect(pairs(graph.edges)).toContain('d1 — n3');
    expect(buildGraph(INPUT, NOTES_ONLY).nodes.some((item) => item.kind === 'day')).toBe(false);
  });

  it('ссылка на скрытую ежедневную заметку не рисуется и не считается недостающей', () => {
    const input: GraphInput = {
      notes: [
        { id: 'a', title: 'Итоги', folder: 'Работа', links: ['2026-10-12', 'Планы'] },
        {
          id: 'd', title: '2026-10-12', folder: 'Дни', links: [], isDaily: true,
        },
      ],
      records: [{ id: 'r', title: 'Ретро', links: ['2026-10-12'] }],
    };
    const hidden = buildGraph(input, { withDays: false, withRecords: true });
    expect(hidden.nodes.map((item) => item.id)).toEqual(['a', 'missing:планы']);
    expect(pairs(hidden.edges)).toEqual(['a — missing:планы']);

    const shown = buildGraph(input, ALL);
    expect(pairs(shown.edges)).toEqual(['a — d', 'a — missing:планы', 'd — r']);
  });

  it('записи планировщика — только с фильтром; одноимённые схлопнуты в один узел', () => {
    const graph = buildGraph(INPUT, { withDays: false, withRecords: true });
    const records = graph.nodes.filter((item) => item.kind === 'record');
    expect(records.map((item) => [item.id, item.title, item.group])).toEqual([
      ['r1', 'Созвон по проекту', 'event'],
      ['r3', 'Написать спеку', 'task'],
    ]);
    // ссылки обоих экземпляров сложились, общая — без дубля
    expect(neighboursOf('r1', graph.edges)).toEqual(new Set(['n1', 'n2']));
    expect(node(graph.nodes, 'r1').degree).toBe(2);
    expect(node(graph.nodes, 'missing:черновик спеки').degree).toBe(1);
    expect(buildGraph(INPUT, NOTES_ONLY).nodes.some((item) => item.kind === 'record')).toBe(false);
  });

  it('запись без ссылок в граф не попадает', () => {
    const graph = buildGraph(INPUT, ALL);
    expect(graph.nodes.some((item) => item.id === 'r4')).toBe(false);
  });

  it('степень — число разных соседей', () => {
    const graph = buildGraph(INPUT, ALL);
    graph.nodes.forEach((item) => {
      expect(item.degree).toBe(neighboursOf(item.id, graph.edges).size);
    });
    expect(node(graph.nodes, 'n4').degree).toBe(0);
    // n2: n1, недостающая, обе записи
    expect(node(graph.nodes, 'n2').degree).toBe(4);
  });

  it('взаимные ссылки дают одну связь, ссылка на себя — ни одной', () => {
    const graph = buildGraph({
      notes: [
        { id: 'a', title: 'А', folder: '', links: ['Б', 'а', ' А '] },
        { id: 'b', title: 'Б', folder: '', links: ['А', 'А'] },
      ],
    }, ALL);
    expect(graph.edges).toEqual([{ from: 'a', to: 'b', isMutual: true }]);
    expect(graph.nodes.map((item) => item.degree)).toEqual([1, 1]);
  });

  it('связь направлена от ссылающейся заметки, встречная ссылка её не переворачивает', () => {
    const graph = buildGraph({
      notes: [
        { id: 'a', title: 'А', folder: '', links: [] },
        { id: 'b', title: 'Б', folder: '', links: ['А', 'В'] },
        { id: 'c', title: 'В', folder: '', links: ['Б'] },
      ],
    }, ALL);
    expect(graph.edges).toEqual([{ from: 'b', to: 'a' }, { from: 'b', to: 'c', isMutual: true }]);
  });

  it('пустые ссылки пропускаются, одноимённые заметки — ссылка ведёт на первую', () => {
    const graph = buildGraph({
      notes: [
        { id: 'a', title: 'Дубль', folder: 'x', links: [] },
        { id: 'b', title: 'дубль', folder: 'y', links: [] },
        { id: 'c', title: 'Ссылается', folder: 'y', links: ['', '   ', 'ДУБЛЬ'] },
        { id: 'a', title: 'Повтор id', folder: 'z', links: ['Ссылается'] },
      ],
    }, ALL);
    expect(graph.nodes.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(graph.edges).toEqual([{ from: 'c', to: 'a' }]);
  });

  it('пустой вход — пустой граф', () => {
    expect(buildGraph({ notes: [] }, ALL)).toEqual({ nodes: [], edges: [] });
  });
});

describe('граф заметок: выбор папок', () => {
  it('в графе только заметки выбранных папок; соседей из других папок нет — ни точкой, ни «ещё нет»', () => {
    const graph = buildGraph(INPUT, { ...NOTES_ONLY, folders: ['Работа'] });
    // «Идеи» лежит в «Личном»: ссылка на неё не рисуется; заметки «Sealed sender» нет вовсе — она «ещё нет»
    expect(graph.nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'missing:sealed sender']);
    expect(pairs(graph.edges)).toEqual(['missing:sealed sender — n2', 'n1 — n2']);
    expect(node(graph.nodes, 'n1').degree).toBe(1);
    expect(graph.nodes.filter((item) => item.kind === 'note').length).toBe(2);
  });

  it('несколько папок, корень — пустая строка, пустой выбор — заметок нет', () => {
    const input: GraphInput = {
      notes: [
        { id: 'a', title: 'А', folder: '', links: ['Б', 'В'] },
        { id: 'b', title: 'Б', folder: 'Работа', links: ['В'] },
        { id: 'c', title: 'В', folder: 'Работа/Вложенная', links: [] },
      ],
    };
    expect(buildGraph(input, { ...NOTES_ONLY, folders: ['', 'Работа'] }).nodes.map(({ id }) => id)).toEqual(['a', 'b']);
    // Путь совпадает точно: вложенная папка — отдельная
    expect(buildGraph(input, { ...NOTES_ONLY, folders: ['Работа/Вложенная'] }).nodes.map(({ id }) => id))
      .toEqual(['c']);
    expect(buildGraph(input, { ...NOTES_ONLY, folders: [] })).toEqual({ nodes: [], edges: [] });
    expect(buildGraph(input, { ...NOTES_ONLY, folders: undefined }).nodes.length).toBe(3);
  });

  it('заметки дней выбор папок не трогает; записи «Плана» — только со ссылкой на видимую заметку', () => {
    const graph = buildGraph(INPUT, { ...ALL, folders: ['Личное'] });
    expect(graph.nodes.map((item) => item.id)).toEqual([
      'n3', 'n4', 'd1', 'missing:sealed sender', 'r3', 'missing:черновик спеки',
    ]);
    expect(pairs(graph.edges)).toEqual([
      'd1 — missing:sealed sender',
      'd1 — n3',
      'missing:черновик спеки — r3',
    ]);
    expect(isNoteInGraph({ folder: 'Дни', isDaily: true }, { withDays: true, folders: [] })).toBe(true);
    expect(isNoteInGraph({ folder: 'Дни', isDaily: true }, { withDays: false })).toBe(false);
    expect(isNoteInGraph({ folder: 'Личное' }, { withDays: false, folders: ['Работа'] })).toBe(false);
  });

  it('смена выбора папок не двигает уже разложенные точки', () => {
    const all = buildGraph(INPUT, NOTES_ONLY);
    const placed = layoutGraph(all.nodes, all.edges, { width: 900, height: 620, isLoose: true });
    const places = new Map(placed.map(({ id, x, y }) => [id, { x, y }]));
    const narrow = buildGraph(INPUT, { ...NOTES_ONLY, folders: ['Работа'] });
    placeGraph(narrow.nodes, narrow.edges, places, { width: 900, height: 620, isLoose: true }).forEach((item) => {
      expect({ x: item.x, y: item.y }).toEqual(places.get(item.id));
    });
  });

  it('папки для выбора: с обычными заметками, корень первым; сохранённый выбор приводится к существующим', () => {
    const folders = listGraphFolders([...INPUT.notes, { folder: '' }, { folder: 'Архив' }, { folder: '' }]);
    expect(folders).toEqual([
      { path: '', count: 2 }, { path: 'Архив', count: 1 }, { path: 'Личное', count: 2 }, { path: 'Работа', count: 2 },
    ]);
    expect(listGraphFolders([{ folder: 'Дни', isDaily: true }])).toEqual([]);
    expect(resolveGraphFolders(undefined, folders)).toBeUndefined();
    expect(resolveGraphFolders(['Работа', 'Удалённая', ''], folders)).toEqual(['', 'Работа']);
    expect(resolveGraphFolders(['Удалённая'], folders)).toBeUndefined();
    expect(resolveGraphFolders(['', 'Архив', 'Личное', 'Работа'], folders)).toBeUndefined();
    expect(resolveGraphFolders([], folders)).toBeUndefined();
  });
});

describe('граф заметок: раскладка', { timeout: HEAVY_TIMEOUT_MS }, () => {
  const BOX = { width: 800, height: 600 };

  it('одно зерно — одинаковый результат, другое зерно — другой', () => {
    const graph = buildGraph(INPUT, ALL);
    const first = layoutGraph(graph.nodes, graph.edges, { ...BOX, seed: 7 });
    const second = layoutGraph(graph.nodes, graph.edges, { ...BOX, seed: 7 });
    const other = layoutGraph(graph.nodes, graph.edges, { ...BOX, seed: 8 });
    expect(second).toEqual(first);
    expect(other.map((item) => [item.x, item.y])).not.toEqual(first.map((item) => [item.x, item.y]));
    // без зерна — зерно по умолчанию, тоже постоянное
    expect(layoutGraph(graph.nodes, graph.edges, BOX)).toEqual(layoutGraph(graph.nodes, graph.edges, BOX));
  });

  it('вход не меняется, порядок и поля узлов сохраняются', () => {
    const graph = buildGraph(INPUT, ALL);
    const snapshot = JSON.stringify(graph);
    const placed = layoutGraph(graph.nodes, graph.edges, BOX);
    expect(JSON.stringify(graph)).toBe(snapshot);
    expect(placed.map(({ x, y, ...rest }) => rest)).toEqual(graph.nodes.map(({ x, y, ...rest }) => rest));
  });

  it('координаты внутри области с отступом', () => {
    const { nodes, edges } = chain(60);
    const small = { width: 320, height: 240 };
    [small, BOX].forEach((box) => {
      layoutGraph(nodes, edges, { ...box, seed: 3 }).forEach((item) => {
        expect(Number.isFinite(item.x) && Number.isFinite(item.y)).toBe(true);
        expect(item.x).toBeGreaterThanOrEqual(GRAPH_MARGIN - 1e-6);
        expect(item.x).toBeLessThanOrEqual(box.width - GRAPH_MARGIN + 1e-6);
        expect(item.y).toBeGreaterThanOrEqual(GRAPH_MARGIN - 1e-6);
        expect(item.y).toBeLessThanOrEqual(box.height - GRAPH_MARGIN + 1e-6);
      });
    });
    layoutGraph(nodes, edges, { ...small, margin: 100, seed: 3 }).forEach((item) => {
      expect(item.x).toBeGreaterThanOrEqual(100 - 1e-6);
      expect(item.y).toBeLessThanOrEqual(140 + 1e-6);
    });
  });

  it('узлы не слипаются, связанные ближе несвязанных', () => {
    const { nodes, edges } = chain(12);
    const placed = layoutGraph(nodes, edges, { width: 2000, height: 2000 });
    const distance = (a: number, b: number) => Math.hypot(placed[a].x - placed[b].x, placed[a].y - placed[b].y);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(distance(i, j)).toBeGreaterThan(10);
      }
    }
    expect(distance(0, 1)).toBeLessThan(distance(0, 11));
  });

  it('пустой граф, один узел, узлы без связей', () => {
    expect(layoutGraph([], [], BOX)).toEqual([]);

    const [single] = layoutGraph(chain(1).nodes, [], BOX);
    expect([single.x, single.y]).toEqual([400, 300]);

    const loose = layoutGraph(chain(5).nodes, [], BOX);
    expect(new Set(loose.map((item) => `${item.x.toFixed(3)}:${item.y.toFixed(3)}`)).size).toBe(5);
    loose.forEach((item) => {
      expect(item.x).toBeGreaterThanOrEqual(GRAPH_MARGIN);
      expect(item.x).toBeLessThanOrEqual(BOX.width - GRAPH_MARGIN);
    });
  });

  it('два отдельных куска графа остаются в области и не разлетаются', () => {
    const a = chain(4);
    const b = chain(4);
    const nodes = [...a.nodes, ...b.nodes.map((item) => ({ ...item, id: `x${item.id}` }))];
    const edges = [...a.edges, ...b.edges.map((edge) => ({ from: `x${edge.from}`, to: `x${edge.to}` }))];
    const placed = layoutGraph(nodes, edges, { width: 4000, height: 4000 });
    placed.forEach((item) => {
      // гравитация держит оба куска около центра
      expect(Math.hypot(item.x - 2000, item.y - 2000)).toBeLessThan(600);
    });
  });

  it('связи с неизвестными узлами и петли не мешают; нулевая область — все в одной точке', () => {
    const { nodes } = chain(3);
    const edges = [{ from: 'n0', to: 'нет' }, { from: 'n1', to: 'n1' }, { from: 'n0', to: 'n2' }];
    const placed = layoutGraph(nodes, edges, BOX);
    placed.forEach((item) => expect(Number.isFinite(item.x + item.y)).toBe(true));

    layoutGraph(nodes, edges, { width: 0, height: 0 }).forEach((item) => {
      expect([item.x, item.y]).toEqual([0, 0]);
    });
  });

  it('ноль итераций — случайная расстановка по зерну, тоже в области', () => {
    const { nodes, edges } = chain(10);
    const placed = layoutGraph(nodes, edges, { ...BOX, iterations: 0, seed: 5 });
    expect(placed).toEqual(layoutGraph(nodes, edges, { ...BOX, iterations: 0, seed: 5 }));
    placed.forEach((item) => {
      expect(item.y).toBeGreaterThanOrEqual(GRAPH_MARGIN - 1e-6);
      expect(item.y).toBeLessThanOrEqual(BOX.height - GRAPH_MARGIN + 1e-6);
    });
  });

  it('потолок работы: до 500 узлов все итерации, дальше меньше', () => {
    expect(getLayoutIterations(0)).toBe(GRAPH_ITERATIONS);
    expect(getLayoutIterations(1)).toBe(GRAPH_ITERATIONS);
    expect(getLayoutIterations(500)).toBe(GRAPH_ITERATIONS);
    expect(getLayoutIterations(1000)).toBe(100);
    expect(getLayoutIterations(2000)).toBe(25);
    expect(getLayoutIterations(100_000)).toBe(1);
    expect(getLayoutIterations(50, 120)).toBe(120);
    expect(getLayoutIterations(50, -5)).toBe(0);
    [600, 1000, 3000].forEach((count) => {
      const work = getLayoutIterations(count) * ((count * (count - 1)) / 2);
      expect(work).toBeLessThanOrEqual(GRAPH_WORK_BUDGET);
    });
  });

  it('потолок работы расстановки: до ~200 новых на 1 000 все шаги, дальше меньше', () => {
    expect(getPlaceIterations(0, 10)).toBe(GRAPH_PLACE_ITERATIONS);
    expect(getPlaceIterations(5, 1)).toBe(GRAPH_PLACE_ITERATIONS);
    expect(getPlaceIterations(200, 1000)).toBe(GRAPH_PLACE_ITERATIONS);
    expect(getPlaceIterations(365, 1000)).toBe(68);
    expect(getPlaceIterations(500, 1000)).toBe(50);
    expect(getPlaceIterations(100_000, 100_000)).toBe(1);
    expect(getPlaceIterations(10, 100, 7)).toBe(7);
    expect(getPlaceIterations(10, 100, 0)).toBe(0);
    [365, 1000, 5000].forEach((free) => {
      expect(getPlaceIterations(free, 5000) * free * 4999).toBeLessThanOrEqual(GRAPH_PLACE_WORK_BUDGET);
    });
  });

  it('большой граф по сетке: повторяем по зерну, в области, без наложений не хуже точного счёта', () => {
    const { nodes, edges } = synth(500);
    expect(nodes.length).toBeGreaterThanOrEqual(GRAPH_GRID_FROM);
    const first = layoutGraph(nodes, edges, { ...BOX, seed: 5 });
    expect(layoutGraph(nodes, edges, { ...BOX, seed: 5 })).toEqual(first);
    expect(layoutGraph(nodes, edges, { ...BOX, seed: 6 }).map(({ x, y }) => [x, y]))
      .not.toEqual(first.map(({ x, y }) => [x, y]));
    first.forEach((item) => {
      expect(item.x).toBeGreaterThanOrEqual(GRAPH_MARGIN - 1e-6);
      expect(item.x).toBeLessThanOrEqual(BOX.width - GRAPH_MARGIN + 1e-6);
      expect(item.y).toBeGreaterThanOrEqual(GRAPH_MARGIN - 1e-6);
      expect(item.y).toBeLessThanOrEqual(BOX.height - GRAPH_MARGIN + 1e-6);
    });
    // Точный счёт всех пар на 500 узлах давал 0 наложений (замер 13 окт 2026); по сетке — не больше 1 на 10 000 пар
    const loose = layoutGraph(nodes, edges, { ...BOX, isLoose: true });
    expect(overlapShare(loose)).toBeLessThanOrEqual(0.0001);
    // Размер графа тот же, что при точном счёте: медиана связи 320 ± 15 %
    const byId = new Map(loose.map((item) => [item.id, item]));
    const lengths = edges.map((edge) => {
      const a = byId.get(edge.from)!;
      const b = byId.get(edge.to)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    }).sort((a, b) => a - b);
    const median = lengths[lengths.length >> 1];
    expect(median).toBeGreaterThan(320 * 0.85);
    expect(median).toBeLessThan(320 * 1.15);
  });

  it('раскладка по шагам: порции дают тот же результат, что разом; работа растёт, конец отмечен', () => {
    const { nodes, edges } = synth(300);
    const whole = layoutGraph(nodes, edges, BOX);
    const run = startGraphLayout(nodes, edges, undefined, BOX);
    expect(run.isDone).toBe(false);
    expect(run.work).toBe(0);
    let steps = 0;
    let lastWork = 0;
    while (!run.step(20_000)) {
      steps++;
      expect(run.work).toBeGreaterThan(lastWork);
      lastWork = run.work;
      // Промежуточные места — тоже внутри области
      run.nodes().forEach((item) => {
        expect(item.x).toBeGreaterThanOrEqual(GRAPH_MARGIN - 1e-6);
        expect(item.x).toBeLessThanOrEqual(BOX.width - GRAPH_MARGIN + 1e-6);
      });
      if (steps > 100_000) throw new Error('раскладка не кончается');
    }
    expect(steps).toBeGreaterThan(1);
    expect(run.isDone).toBe(true);
    expect(run.nodes()).toEqual(whole);
    // После конца шаг ничего не делает
    const work = run.work;
    expect(run.step(1000)).toBe(true);
    expect(run.work).toBe(work);
  });

  it('пустой граф и один узел по шагам — сразу готовы', () => {
    expect(startGraphLayout([], [], undefined, BOX).isDone).toBe(true);
    const single = startGraphLayout([chain(1).nodes[0]], [], undefined, BOX);
    expect(single.isDone).toBe(true);
    expect(single.nodes()).toEqual([{ ...chain(1).nodes[0], x: 400, y: 300 }]);
  });

  it('генератор с зерном повторяем и даёт числа в [0, 1)', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const values = Array.from({ length: 200 }, () => a());
    expect(Array.from({ length: 200 }, () => b())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(190);
    expect(createSeededRandom(43)()).not.toBe(values[0]);
  });
});

describe('граф заметок: соседи и размер точки', () => {
  const edges: GraphEdge[] = [
    { from: 'a', to: 'b' }, { from: 'c', to: 'a' }, { from: 'b', to: 'c' }, { from: 'd', to: 'd' },
  ];

  it('соседи — в обе стороны, без самого узла', () => {
    expect(neighboursOf('a', edges)).toEqual(new Set(['b', 'c']));
    expect(neighboursOf('d', edges)).toEqual(new Set());
    expect(neighboursOf('нет', edges)).toEqual(new Set());
  });

  it('радиус растёт с числом связей и ограничен', () => {
    expect(nodeRadius(0)).toBe(GRAPH_MIN_RADIUS);
    expect(nodeRadius(4)).toBeCloseTo(12.4);
    expect(nodeRadius(9)).toBeGreaterThan(nodeRadius(4));
    expect(nodeRadius(10_000)).toBe(GRAPH_MAX_RADIUS);
    expect(nodeRadius(-3)).toBe(GRAPH_MIN_RADIUS);
    expect(nodeRadius(Number.NaN)).toBe(GRAPH_MIN_RADIUS);
  });
});

describe('граф заметок: место новых узлов', { timeout: HEAVY_TIMEOUT_MS }, () => {
  const OPTIONS = { width: 800, height: 600, seed: 4 };

  function positions(nodes: GraphNode[]) {
    return new Map(nodes.map((item) => [item.id, { x: item.x, y: item.y }]));
  }

  it('свободная раскладка не сжимается в область и стоит вокруг её центра', () => {
    const { nodes, edges } = chain(60);
    const small = { width: 200, height: 200, seed: 2 };
    const tight = layoutGraph(nodes, edges, small);
    const loose = layoutGraph(nodes, edges, { ...small, isLoose: true });
    const span = (placed: GraphNode[]) => (
      Math.max(...placed.map((item) => item.x)) - Math.min(...placed.map((item) => item.x))
    );
    expect(span(tight)).toBeLessThanOrEqual(200);
    expect(span(loose)).toBeGreaterThan(400);
    const xs = loose.map((item) => item.x);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(100, 6);
  });

  it('без прежних мест — полная раскладка', () => {
    const { nodes, edges } = chain(6);
    expect(placeGraph(nodes, edges, new Map(), OPTIONS)).toEqual(layoutGraph(nodes, edges, OPTIONS));
  });

  it('новая связь не двигает ни один узел', () => {
    const { nodes, edges } = chain(12);
    const placed = layoutGraph(nodes, edges, OPTIONS);
    const next = placeGraph(nodes, [...edges, { from: 'n0', to: 'n11' }], positions(placed), OPTIONS);
    expect(next.map(({ id, x, y }) => [id, x, y])).toEqual(placed.map(({ id, x, y }) => [id, x, y]));
  });

  it('новый узел встаёт рядом с соседом, остальные стоят на месте', () => {
    const { nodes, edges } = chain(12);
    const placed = layoutGraph(nodes, edges, OPTIONS);
    const added: GraphNode = {
      id: 'new', title: 'Новая', kind: 'note', degree: 1, x: 0, y: 0,
    };
    const next = placeGraph([...nodes, added], [...edges, { from: 'n3', to: 'new' }], positions(placed), OPTIONS);
    placed.forEach((item) => {
      const moved = node(next, item.id);
      expect(Math.hypot(moved.x - item.x, moved.y - item.y)).toBeLessThan(1e-9);
    });
    const fresh = node(next, 'new');
    const anchor = node(next, 'n3');
    const reach = Math.hypot(fresh.x - anchor.x, fresh.y - anchor.y);
    expect(reach).toBeGreaterThan(GRAPH_SPRING_LENGTH / 3);
    expect(reach).toBeLessThan(GRAPH_SPRING_LENGTH * 3);
    placed.forEach((item) => {
      expect(Math.hypot(fresh.x - item.x, fresh.y - item.y)).toBeGreaterThan(GRAPH_SPRING_LENGTH / 3);
    });
    expect(placeGraph([...nodes, added], [...edges, { from: 'n3', to: 'new' }], positions(placed), OPTIONS))
      .toEqual(next);
  });

  it('узел без связей встаёт с краю, а не в гущу', () => {
    const { nodes, edges } = chain(8);
    const placed = layoutGraph(nodes, edges, OPTIONS);
    const loner: GraphNode = {
      id: 'new', title: 'Одна', kind: 'note', degree: 0, x: 0, y: 0,
    };
    const fresh = node(placeGraph([...nodes, loner], edges, positions(placed), OPTIONS), 'new');
    expect(Number.isFinite(fresh.x) && Number.isFinite(fresh.y)).toBe(true);
    placed.forEach((item) => {
      expect(Math.hypot(fresh.x - item.x, fresh.y - item.y)).toBeGreaterThan(GRAPH_SPRING_LENGTH / 3);
    });
  });

  it('два новых узла у одного соседа не сливаются', () => {
    const { nodes, edges } = chain(4);
    const placed = layoutGraph(nodes, edges, OPTIONS);
    const extra = ['p', 'q'].map((id): GraphNode => ({
      id, title: id, kind: 'note', degree: 1, x: 0, y: 0,
    }));
    const next = placeGraph(
      [...nodes, ...extra], [...edges, { from: 'n1', to: 'p' }, { from: 'n1', to: 'q' }], positions(placed), OPTIONS,
    );
    const p = node(next, 'p');
    const q = node(next, 'q');
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(GRAPH_SPRING_LENGTH / 3);
  });

  it('большой граф по сетке: стоящие узлы не двигаются, новые встают без наложений и повторяемо', () => {
    const base = synth(400);
    const placed = layoutGraph(base.nodes, base.edges, { ...OPTIONS, isLoose: true });
    const previous = positions(placed);
    const grown = synth(400 + 365, 5);
    const next = placeGraph(grown.nodes, grown.edges, previous, { ...OPTIONS, isLoose: true });
    expect(next.length).toBe(765);
    placed.forEach((item) => expect(node(next, item.id)).toMatchObject({ x: item.x, y: item.y }));
    expect(placeGraph(grown.nodes, grown.edges, previous, { ...OPTIONS, isLoose: true })).toEqual(next);
    // Точный счёт на тех же данных давал до 1 наложения на 10 000 пар (замер 13 окт 2026)
    expect(overlapShare(next)).toBeLessThanOrEqual(0.0002);
    // Шагами — то же самое
    const run = startGraphLayout(grown.nodes, grown.edges, previous, { ...OPTIONS, isLoose: true });
    while (!run.step(50_000)) { /* порциями */ }
    expect(run.nodes()).toEqual(next);
  });

  it('созданная заметка занимает место «заметки, которой ещё нет»', () => {
    const previous = new Map([['a', { x: 10, y: 20 }], ['missing:новая тема', { x: 300, y: -40 }]]);
    const nodes: GraphNode[] = [
      {
        id: 'a', title: 'А', kind: 'note', degree: 1, x: 0, y: 0,
      },
      {
        id: 'n9', title: 'Новая тема', kind: 'note', degree: 1, x: 0, y: 0,
      },
    ];
    const next = placeGraph(nodes, [{ from: 'a', to: 'n9' }], previous, OPTIONS);
    expect(next.map(({ x, y }) => [x, y])).toEqual([[10, 20], [300, -40]]);
  });
});

describe('граф заметок: попадание в узел, правка связей, стрелка', () => {
  const NODES: GraphNode[] = [
    {
      id: 'a', title: 'А', kind: 'note', degree: 0, x: 0, y: 0,
    },
    {
      id: 'b', title: 'Б', kind: 'missing', degree: 4, x: 100, y: 0,
    },
  ];

  it('узел под точкой — с запасом и без', () => {
    expect(nodeAt(NODES, 3, 3)?.id).toBe('a');
    expect(nodeAt(NODES, 10, 0)).toBeUndefined();
    expect(nodeAt(NODES, 10, 0, 6)?.id).toBe('a');
    expect(nodeAt(NODES, 90, 5)?.id).toBe('b');
    expect(nodeAt(NODES, 50, 50, 10)).toBeUndefined();
    expect(nodeAt([], 0, 0, 100)).toBeUndefined();
  });

  it('связь ведут от заметки к заметке, существующей или будущей', () => {
    expect(['note', 'missing', 'day', 'record'].map((kind) => canLinkFrom({ kind } as GraphNode)))
      .toEqual([true, false, false, false]);
    expect(['note', 'missing', 'day', 'record'].map((kind) => canLinkTo({ kind } as GraphNode)))
      .toEqual([true, true, false, false]);
    expect(canLinkFrom(undefined)).toBe(false);
    expect(canLinkTo(undefined)).toBe(false);
  });

  it('линия идёт от края до края кружков, наконечник — у цели', () => {
    const shape = edgeShape({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 10);
    expect([shape.x1, shape.y1, shape.x2, shape.y2]).toEqual([6 + GRAPH_EDGE_GAP, 0, 90 - GRAPH_EDGE_GAP, 0]);
    expect(shape.heads).toEqual([`M87 0L${87 - GRAPH_ARROW} 3.5L${87 - GRAPH_ARROW} -3.5Z`]);
    expect(shape.middle).toEqual({ x: 50, y: 0 });
  });

  it('взаимная связь — наконечники с обеих сторон, кружки вплотную — без наконечников', () => {
    expect(edgeShape({ x: 0, y: 0 }, { x: 0, y: 200 }, 6, 6, true).heads).toHaveLength(2);
    const near = edgeShape({ x: 0, y: 0 }, { x: 20, y: 0 }, 6, 6);
    expect(near.heads).toEqual([]);
    expect([near.x1, near.x2]).toEqual([0, 20]);
    expect(edgeShape({ x: 5, y: 5 }, { x: 5, y: 5 }, 6, 6).heads).toEqual([]);
  });
});
