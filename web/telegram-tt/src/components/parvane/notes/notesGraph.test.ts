import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphInput, GraphNode } from './notesGraph';

import {
  buildGraph, createSeededRandom, getLayoutIterations, GRAPH_ITERATIONS, GRAPH_MARGIN, GRAPH_MAX_RADIUS,
  GRAPH_MIN_RADIUS, GRAPH_WORK_BUDGET, layoutGraph, neighboursOf, nodeRadius,
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
    expect(graph.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect(graph.nodes.map((item) => item.degree)).toEqual([1, 1]);
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

describe('граф заметок: раскладка', () => {
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
