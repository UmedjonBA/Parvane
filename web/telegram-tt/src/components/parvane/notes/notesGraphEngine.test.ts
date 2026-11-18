import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  beforeAll, describe, expect, it,
} from 'vitest';

import type { NotesGraphInput } from './notesGraphEngine';

import { engineStatic, loadProtocol } from '../../../api/parvane/v2/engine';
import { layoutNotesCanvas, layoutNotesGraph, notesGraphEdgePath } from './notesGraphEngine';

type Case = { name: string; call: string; args: NotesGraphInput; expect: unknown };

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../conformance/notes-graph/cases.json'), 'utf8'),
) as { cases: Case[] };

// Тот же выдуманный граф, что в тесте движка `thousand_nodes_are_laid_out_without_overlaps`
function bigInput(count: number): NotesGraphInput {
  const title = (index: number) => `Заметка номер ${index} о делах`;
  return {
    seed: 1,
    notes: Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      title: title(index),
      folder: `Папка ${index % 12}`,
      links: index % 10 === 9 ? [] : [
        title(Math.floor(index / 25) * 25),
        ...(index % 3 === 0 ? [title((index * 7 + 3) % count)] : []),
      ],
    })),
  };
}

describe('Граф заметок (NOTES-1)', () => {
  beforeAll(async () => {
    await loadProtocol();
  });

  it('движок web отвечает по общему образцу', () => {
    expect(SAMPLE.cases.length).toBeGreaterThanOrEqual(10);
    SAMPLE.cases.forEach((sample) => {
      expect(engineStatic(sample.call, sample.args), sample.name).toEqual(sample.expect);
    });
  });

  it('обёртка: граф и холст одной области, зерно по умолчанию, путь связи', () => {
    const { args } = SAMPLE.cases[0];
    const graph = layoutNotesGraph({ ...args, seed: undefined, scope: { kind: 'tag', tag: 'книги' } });
    expect(graph.nodes.map((node) => node.id)).toEqual(['n8', 'n9']);
    expect(graph).toEqual(layoutNotesGraph({ ...args, seed: 1, scope: { kind: 'tag', tag: 'книги' } }));
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].mutual).toBe(true);
    expect(notesGraphEdgePath(graph.edges[0])).toMatch(/^M\d+ \d+L\d+ \d+$/);
    expect(notesGraphEdgePath({ ...graph.edges[0], curved: true })).toMatch(/^M\d+ \d+Q\d+ \d+ \d+ \d+$/);

    const canvas = layoutNotesCanvas({ ...args, scope: { kind: 'tag', tag: 'книги' } });
    expect(canvas.cards.map((card) => card.id)).toEqual(['n8', 'n9']);
    expect(canvas.cards[1].y).toBeGreaterThan(canvas.cards[0].y);
    expect(canvas.edges[0]).toMatchObject({ from: 'n8', to: 'n9', fromSide: 'bottom', toSide: 'top' });

    expect(() => engineStatic('notesGraphLayout', { notes: 'не список' })).toThrow();
  });

  it('1000 заметок: раскладка без наложений за разумное время', () => {
    const input = bigInput(1000);
    const started = performance.now();
    const graph = layoutNotesGraph(input);
    const layoutMs = performance.now() - started;
    const canvasStarted = performance.now();
    const canvas = layoutNotesCanvas(input);
    const canvasMs = performance.now() - canvasStarted;
    // eslint-disable-next-line no-console
    console.log(`notes-graph 1000 (WASM): раскладка ${Math.round(layoutMs)} мс, холст ${Math.round(canvasMs)} мс`);
    expect(graph.nodes).toHaveLength(1000);
    expect(canvas.cards).toHaveLength(1000);

    // Кружки и показанные подписи разных узлов не пересекаются (перебор по полосам вдоль x)
    const rects = graph.nodes.map((node) => [
      [node.x - node.r, node.y - node.r, node.x + node.r, node.y + node.r],
      ...(node.label.show
        ? [[node.label.x, node.label.y, node.label.x + node.label.w, node.label.y + node.label.h]] : []),
    ]);
    const order = rects.map((_, index) => index)
      .sort((a, b) => Math.min(...rects[a].map((r) => r[0])) - Math.min(...rects[b].map((r) => r[0])));
    let overlaps = 0;
    order.forEach((i, at) => {
      const right = Math.max(...rects[i].map((r) => r[2]));
      for (let next = at + 1; next < order.length; next++) {
        const j = order[next];
        if (Math.min(...rects[j].map((r) => r[0])) >= right) break;
        rects[i].forEach((a) => rects[j].forEach((b) => {
          if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) overlaps++;
        }));
      }
    });
    expect(overlaps).toBe(0);
    expect(layoutMs).toBeLessThan(5000);
  });
});
