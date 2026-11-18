import {
  beforeAll, describe, expect, it,
} from 'vitest';

import type { GraphNoteSource } from './notesGraphView';

import { loadProtocol } from '../../../api/parvane/v2/engine';
import { layoutNotesGraph } from './notesGraphEngine';
import {
  applyGraphPlaces, arrowHeadPath, buildGraphInput, clipGraphLabel, edgeHeads, edgePoint, GRAPH_ALL, graphRects,
  labelAnchor, neighboursOf, nodeAt, NOTES_GRAPH_METRICS, parseGraphFilter, resolveGraphScope, scopeKey,
} from './notesGraphView';

function note(title: string, links: string[] = [], extra: Partial<GraphNoteSource> = {}): GraphNoteSource {
  return {
    id: `id-${title}`, title, folder: '', links, tags: [], ...extra,
  };
}

const NOTES = [
  note('Маяк', ['Причал', 'Нет такой']),
  note('Причал', ['Маяк'], { folder: 'Порт', tags: ['#море/суда'] }),
  note('Склад', [], { folder: 'Порт/Берег' }),
  note('Одна'),
];
const OPTIONS = { withDays: false, withRecords: false, aspect: 1.5 };

describe('показ графа заметок', () => {
  beforeAll(async () => {
    await loadProtocol();
  });

  it('вход движка несёт размеры подписи макета и область', () => {
    const input = buildGraphInput(NOTES, [], { ...GRAPH_ALL, hideOrphans: true }, OPTIONS);
    expect(input).toMatchObject({ ...NOTES_GRAPH_METRICS, hideOrphans: true, scope: { kind: 'all' }, aspect: 1.5 });
    const layout = layoutNotesGraph(input);
    expect(layout.nodes.map(({ id }) => id).sort()).toEqual(['id-Маяк', 'id-Причал', 'missing:нет такой']);
    layout.nodes.forEach((node) => {
      expect(node.label.w).toBeLessThanOrEqual(NOTES_GRAPH_METRICS.labelMaxWidth);
      expect(node.label.h).toBe(NOTES_GRAPH_METRICS.labelHeight);
    });
  });

  it('область, которой не из чего собраться, читается как «все заметки»', () => {
    expect(resolveGraphScope({ kind: 'folder', folder: 'Порт' }, NOTES)).toEqual({ kind: 'folder', folder: 'Порт' });
    expect(resolveGraphScope({ kind: 'folder', folder: 'Пор' }, NOTES)).toEqual({ kind: 'all' });
    expect(resolveGraphScope({ kind: 'tag', tag: 'Море' }, NOTES)).toEqual({ kind: 'tag', tag: 'Море' });
    expect(resolveGraphScope({ kind: 'tag', tag: 'суда' }, NOTES)).toEqual({ kind: 'all' });
    expect(resolveGraphScope({ kind: 'around', note: 'id-Одна', depth: 2 }, NOTES).kind).toBe('around');
    expect(resolveGraphScope({ kind: 'around', note: 'id-Нет', depth: 2 }, NOTES)).toEqual({ kind: 'all' });
  });

  it('сохранённая область разбирается строго; у каждой области свой ключ расстановки', () => {
    expect(parseGraphFilter(undefined)).toEqual(GRAPH_ALL);
    expect(parseGraphFilter({ scope: { kind: 'around', note: 'n', depth: 7 }, hideMissing: true }))
      .toEqual({ scope: { kind: 'around', note: 'n', depth: 3 }, hideOrphans: false, hideMissing: true });
    expect(parseGraphFilter({ scope: { kind: 'tag', tag: '' } }).scope).toEqual({ kind: 'all' });
    expect(scopeKey({ kind: 'all' })).toBe('all');
    expect(scopeKey({ kind: 'folder', folder: 'Порт' })).toBe('folder:Порт');
    expect(scopeKey({ kind: 'tag', tag: 'Море' })).toBe('tag:море');
    expect(scopeKey({ kind: 'around', note: 'n', depth: 2 })).toBe('around:n:2');
  });

  it('подпись обрезается по ширине, которую отвёл движок', () => {
    expect(clipGraphLabel('Маяк', 70, 7)).toBe('Маяк');
    expect(clipGraphLabel('Очень длинное название заметки', 70, 7)).toBe('Очень дли…');
    expect([...clipGraphLabel('Очень длинное название заметки', 70, 7)].length).toBe(10);
    expect(clipGraphLabel('Абв', 1, 7)).toBe('А…');
  });

  it('точка привязки подписи зависит от стороны', () => {
    const label = {
      x: 100, y: 40, w: 60, h: 18, show: true,
    };
    expect(labelAnchor({ ...label, side: 'bottom' })).toMatchObject({ x: 130, anchor: 'middle' });
    expect(labelAnchor({ ...label, side: 'right' })).toMatchObject({ x: 100, anchor: 'start' });
    expect(labelAnchor({ ...label, side: 'left' })).toMatchObject({ x: 160, anchor: 'end' });
  });

  it('наконечник — у конца связи, у взаимной — у обоих; на слишком короткой линии его нет', () => {
    const edge = {
      from: 'a', to: 'b', mutual: false, x1: 0, y1: 0, cx: 50, cy: 0, x2: 100, y2: 0, curved: false,
    };
    expect(edgeHeads(edge)).toEqual(['M100 0L93 3.5L93 -3.5Z']);
    expect(edgeHeads({ ...edge, mutual: true })).toHaveLength(2);
    expect(arrowHeadPath(0, 0, 3, 0)).toBeUndefined();
    expect(edgePoint(edge)).toEqual({ x: 50, y: 0 });
    expect(edgePoint({ ...edge, cy: 40, curved: true }).y).toBe(20);
  });

  it('ручная расстановка: точка стоит, где её поставили, подпись едет за ней, её связи — прямые', () => {
    const layout = layoutNotesGraph(buildGraphInput(NOTES, [], GRAPH_ALL, OPTIONS));
    expect(applyGraphPlaces(layout, {})).toBe(layout);
    expect(applyGraphPlaces(layout, { 'id-Чужая': { x: 1, y: 1 } })).toBe(layout);

    const before = layout.nodes.find(({ id }) => id === 'id-Маяк')!;
    const at = { x: before.x + 300, y: before.y - 120 };
    const placed = applyGraphPlaces(layout, { 'id-Маяк': at });
    const after = placed.nodes.find(({ id }) => id === 'id-Маяк')!;
    expect([after.x, after.y]).toEqual([at.x, at.y]);
    expect([after.label.x - after.x, after.label.y - after.y])
      .toEqual([before.label.x - before.x, before.label.y - before.y]);
    placed.nodes.filter(({ id }) => id !== 'id-Маяк').forEach((node, i) => {
      expect(node).toBe(layout.nodes.filter(({ id }) => id !== 'id-Маяк')[i]);
    });
    placed.edges.forEach((edge, i) => {
      const isTouched = edge.from === 'id-Маяк' || edge.to === 'id-Маяк';
      if (!isTouched) {
        expect(edge).toBe(layout.edges[i]);
        return;
      }
      expect(edge.curved).toBe(false);
      const from = placed.nodes.find(({ id }) => id === edge.from)!;
      const to = placed.nodes.find(({ id }) => id === edge.to)!;
      expect(Math.hypot(edge.x1 - from.x, edge.y1 - from.y)).toBeCloseTo(from.r, 5);
      expect(Math.hypot(edge.x2 - to.x, edge.y2 - to.y)).toBeCloseTo(to.r, 5);
    });
  });

  it('попадание в точку, соседи и прямоугольники для «Вписать»', () => {
    const layout = layoutNotesGraph(buildGraphInput(NOTES, [], GRAPH_ALL, OPTIONS));
    const node = layout.nodes[0];
    expect(nodeAt(layout.nodes, node.x + node.r - 1, node.y)?.id).toBe(node.id);
    expect(nodeAt(layout.nodes, node.x + node.r + 3, node.y)).toBeUndefined();
    expect(nodeAt(layout.nodes, node.x + node.r + 3, node.y, 5)?.id).toBe(node.id);
    expect([...neighboursOf('id-Маяк', layout.edges)].sort()).toEqual(['id-Причал', 'missing:нет такой']);
    expect(graphRects(layout.nodes)).toHaveLength(layout.nodes.length * 2);
  });
});
