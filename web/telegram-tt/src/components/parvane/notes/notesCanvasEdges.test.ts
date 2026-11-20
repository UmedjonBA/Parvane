import { describe, expect, it } from 'vitest';

import type { CanvasDoc } from './notesCanvas';

import {
  edgeDirectionOf, edgeLineOf, parseDroppedNotes, reconnectEdge, setEdgeDirection, setEdgeLine, swapEdgeEnds,
} from './notesCanvasEdges';
import { summarizeCanvas } from './notesCanvasList';
import { minimapFrame, viewFromMinimap } from './notesCanvasMinimap';

function makeDoc(): CanvasDoc {
  return {
    nodes: [
      {
        id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50,
      },
      {
        id: 'b', type: 'text', x: 300, y: 0, width: 100, height: 50,
      },
      {
        id: 'c', type: 'text', x: 0, y: 200, width: 100, height: 50, color: '4',
      },
    ],
    edges: [{
      id: 'e', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'через',
    }],
  };
}

describe('стрелка холста: направление, линия, концы', () => {
  it('направление — наконечники концов', () => {
    const doc = makeDoc();
    expect(edgeDirectionOf(doc.edges[0])).toBe('forward');
    const both = setEdgeDirection(doc, 'e', 'both');
    expect(both.edges[0]).toMatchObject({ fromEnd: 'arrow' });
    expect(both.edges[0].toEnd).toBeUndefined();
    expect(edgeDirectionOf(both.edges[0])).toBe('both');
    const none = setEdgeDirection(doc, 'e', 'none');
    expect(none.edges[0]).toMatchObject({ toEnd: 'none' });
    expect('fromEnd' in none.edges[0]).toBe(false);
    expect(edgeDirectionOf(setEdgeDirection(doc, 'e', 'back').edges[0])).toBe('back');
  });

  it('пунктир — `styleAttributes.path`, чужие поля стиля остаются', () => {
    const doc = makeDoc();
    doc.edges[0].styleAttributes = { pathfindingMethod: 'square' };
    const dashed = setEdgeLine(doc, 'e', 'dashed');
    expect(edgeLineOf(dashed.edges[0])).toBe('dashed');
    expect(dashed.edges[0].styleAttributes).toEqual({ pathfindingMethod: 'square', path: 'long-dashed' });
    const solid = setEdgeLine(dashed, 'e', 'solid');
    expect(solid.edges[0].styleAttributes).toEqual({ pathfindingMethod: 'square' });
    expect(setEdgeLine(solid, 'e', 'solid')).toBe(solid);
  });

  it('«Поменять концы» меняет узлы, стороны и наконечники', () => {
    const swapped = swapEdgeEnds(makeDoc(), 'e');
    expect(swapped.edges[0]).toEqual({
      id: 'e', fromNode: 'b', toNode: 'a', fromSide: 'left', toSide: 'right', fromEnd: 'arrow', toEnd: 'none',
      label: 'через',
    });
    expect(edgeDirectionOf(swapped.edges[0])).toBe('back');
  });

  it('перецепление конца — на другую карточку, не на ту же, что держит другой конец', () => {
    const doc = makeDoc();
    const moved = reconnectEdge(doc, 'e', 'to', 'c', 'top');
    expect(moved.edges[0]).toMatchObject({ fromNode: 'a', toNode: 'c', toSide: 'top', label: 'через' });
    expect(reconnectEdge(doc, 'e', 'to', 'a', 'top')).toBe(doc);
    expect(reconnectEdge(doc, 'e', 'from', 'missing', 'top')).toBe(doc);
    expect(reconnectEdge(doc, 'e', 'from', 'c', 'bottom').edges[0])
      .toMatchObject({ fromNode: 'c', fromSide: 'bottom' });
  });
});

describe('сводка холста для списка', () => {
  it('карточки без групп, стрелки, миниатюра в долях рамки', () => {
    const doc = makeDoc();
    doc.nodes.push({
      id: 'g', type: 'group', x: -10, y: -10, width: 420, height: 270,
    });
    const summary = summarizeCanvas(JSON.stringify(doc));
    expect(summary.cards).toBe(3);
    expect(summary.arrows).toBe(1);
    expect(summary.preview).toHaveLength(3);
    summary.preview.forEach((card) => {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(1.0001);
    });
    expect(summary.preview.find((card) => card.color === '4')).toBeTruthy();
  });

  it('пустой и повреждённый холст', () => {
    expect(summarizeCanvas('')).toEqual({ cards: 0, arrows: 0, preview: [] });
    expect(summarizeCanvas('{нет')).toEqual({ cards: 0, arrows: 0, preview: [] });
  });
});

describe('мини-карта холста', () => {
  it('рамка вмещает карточки и видимую часть; нажатие в середину рамки ставит её середину в середину поля', () => {
    const view = { scale: 0.5, x: 100, y: 50 };
    const frame = minimapFrame([{
      x: 0, y: 0, width: 400, height: 200,
    }], view, 800, 600);
    expect(frame.visible).toEqual({
      x: -200, y: -100, width: 1600, height: 1200,
    });
    expect(frame.box.x).toBeLessThan(-200);
    expect(frame.box.x + frame.box.width).toBeGreaterThan(1400);
    const aspect = frame.box.width / frame.box.height;
    const next = viewFromMinimap(frame, 0.5, 0.5, aspect, view, 800, 600);
    const centerX = frame.box.x + frame.box.width / 2;
    const centerY = frame.box.y + frame.box.height / 2;
    expect(next.scale).toBe(0.5);
    expect(400 - centerX * 0.5).toBeCloseTo(next.x);
    expect(300 - centerY * 0.5).toBeCloseTo(next.y);
  });
});

describe('перетаскивание на холст', () => {
  it('ссылки на заметки — карточки, прочее — вставка текстом', () => {
    expect(parseDroppedNotes('[[Сервер]]')).toEqual(['Сервер']);
    expect(parseDroppedNotes(' [[Сервер|сервер]]\n[[Книги#Глава]]\n[[Сервер]]\n')).toEqual(['Сервер', 'Книги']);
    expect(parseDroppedNotes('см. [[Сервер]]')).toBeUndefined();
    expect(parseDroppedNotes('')).toBeUndefined();
  });
});
