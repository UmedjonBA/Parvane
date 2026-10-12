import { describe, expect, it } from 'vitest';

import type { CanvasDoc, CanvasNode } from './notesCanvas';

import { findNode } from './notesCanvas';
import {
  alignNodes, distributeNodes, snapResize, snapToNeighbours,
} from './notesCanvasAlign';

function node(id: string, x: number, y: number, width = 100, height = 60, type = 'text'): CanvasNode {
  return {
    id, type, x, y, width, height,
  };
}

function place(doc: CanvasDoc, id: string) {
  const { x, y } = findNode(doc, id)!;
  return [x, y];
}

describe('прилипание к соседям при сдвиге', () => {
  const neighbour = {
    x: 0, y: 0, width: 100, height: 60,
  };

  it('левый край встаёт на левый край соседа, линия идёт через оба', () => {
    const snap = snapToNeighbours({
      x: 4, y: 200, width: 80, height: 40,
    }, [neighbour]);
    expect(snap.dx).toBe(-4);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([{
      axis: 'x', at: 0, from: 0, to: 240,
    }]);
  });

  it('середина к середине и край к краю по обеим осям', () => {
    // Середина по x: 50 у соседа, 47 у карточки; верх карточки в 3 точках от низа соседа
    const snap = snapToNeighbours({
      x: 7, y: 63, width: 80, height: 40,
    }, [neighbour]);
    expect(snap.dx).toBe(3);
    expect(snap.dy).toBe(-3);
    expect(snap.guides).toEqual([
      {
        axis: 'x', at: 50, from: 0, to: 100,
      },
      {
        axis: 'y', at: 60, from: 0, to: 100,
      },
    ]);
  });

  it('из нескольких совпадений берётся ближайшее', () => {
    const snap = snapToNeighbours({
      x: 105, y: 300, width: 80, height: 40,
    }, [neighbour, {
      x: 103, y: 500, width: 50, height: 50,
    }]);
    expect(snap.dx).toBe(-2);
    expect(snap.guides[0]).toMatchObject({ axis: 'x', at: 103, to: 550 });
  });

  it('дальше допуска — ни сдвига, ни линий', () => {
    expect(snapToNeighbours({
      x: 300, y: 300, width: 80, height: 40,
    }, [neighbour])).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapToNeighbours(neighbour, [])).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('уже стоящий вровень узел не сдвигается, но линия показана', () => {
    const snap = snapToNeighbours({
      x: 0, y: 200, width: 100, height: 40,
    }, [neighbour]);
    expect(snap.dx).toBe(0);
    expect(snap.guides.map((guide) => guide.at)).toEqual([0, 50, 100]);
  });
});

describe('прилипание при смене размера', () => {
  const neighbour = {
    x: 300, y: 0, width: 100, height: 200,
  };
  const rect = {
    x: 0, y: 0, width: 296, height: 197,
  };

  it('прилипают только стороны, которые двигает ручка', () => {
    const { rect: next, guides } = snapResize(rect, 'se', [neighbour]);
    expect(next).toEqual({
      x: 0, y: 0, width: 300, height: 200,
    });
    expect(guides.map((guide) => [guide.axis, guide.at])).toEqual([['x', 300], ['y', 200]]);
    expect(snapResize(rect, 'e', [neighbour]).rect).toEqual({ ...rect, width: 300 });
    // Ручка слева двигает левый край: он уже стоит вровень с ничем
    expect(snapResize(rect, 'w', [neighbour]).rect).toEqual(rect);
  });

  it('прилипание не делает прямоугольник меньше наименьшего', () => {
    const small = {
      x: 0, y: 0, width: 84, height: 60,
    };
    const { rect: next } = snapResize(small, 'e', [{
      x: 78, y: 300, width: 50, height: 50,
    }]);
    expect(next).toEqual(small);
  });
});

describe('выравнивание и распределение', () => {
  function sample(): CanvasDoc {
    return {
      nodes: [node('a', 0, 0), node('b', 150, 100, 200, 100), node('c', 500, 40, 100, 20)],
      edges: [],
    };
  }

  it('по левому краю, по середине, по правому краю', () => {
    const ids = ['a', 'b', 'c'];
    expect(['a', 'b', 'c'].map((id) => place(alignNodes(sample(), ids, 'left'), id)[0])).toEqual([0, 0, 0]);
    expect(['a', 'b', 'c'].map((id) => place(alignNodes(sample(), ids, 'center'), id)[0])).toEqual([250, 200, 250]);
    expect(['a', 'b', 'c'].map((id) => place(alignNodes(sample(), ids, 'right'), id)[0])).toEqual([500, 400, 500]);
  });

  it('по верху, по середине, по низу', () => {
    const ids = ['a', 'b', 'c'];
    expect(['a', 'b', 'c'].map((id) => place(alignNodes(sample(), ids, 'top'), id)[1])).toEqual([0, 0, 0]);
    expect(['a', 'b', 'c'].map((id) => place(alignNodes(sample(), ids, 'middle'), id)[1])).toEqual([70, 50, 90]);
    expect(['a', 'b', 'c'].map((id) => place(alignNodes(sample(), ids, 'bottom'), id)[1])).toEqual([140, 100, 180]);
  });

  it('группа едет с содержимым, узел внутри выделенной группы сам не выравнивается', () => {
    const doc: CanvasDoc = {
      nodes: [node('g', 100, 0, 300, 200, 'group'), node('in', 150, 50), node('out', 0, 300)],
      edges: [],
    };
    const next = alignNodes(doc, ['g', 'in', 'out'], 'left');
    expect(place(next, 'g')).toEqual([0, 0]);
    expect(place(next, 'in')).toEqual([50, 50]);
    expect(place(next, 'out')).toEqual([0, 300]);
  });

  it('один предмет не выравнивается, два не распределяются', () => {
    const doc = sample();
    expect(alignNodes(doc, ['a'], 'left')).toBe(doc);
    expect(distributeNodes(doc, ['a', 'b'], 'x')).toBe(doc);
  });

  it('равные промежутки по горизонтали: крайние стоят', () => {
    // Ширины 100, 200, 100 между 0 и 600: свободно 200, промежуток 100
    const next = distributeNodes(sample(), ['c', 'a', 'b'], 'x');
    expect(['a', 'b', 'c'].map((id) => place(next, id)[0])).toEqual([0, 200, 500]);
    expect(['a', 'b', 'c'].map((id) => place(next, id)[1])).toEqual([0, 100, 40]);
  });

  it('равные промежутки по вертикали', () => {
    const doc: CanvasDoc = { nodes: [node('a', 0, 0), node('b', 0, 70), node('c', 0, 300)], edges: [] };
    // Высоты по 60 между 0 и 360: свободно 180, промежуток 90
    const next = distributeNodes(doc, ['a', 'b', 'c'], 'y');
    expect(['a', 'b', 'c'].map((id) => place(next, id)[1])).toEqual([0, 150, 300]);
  });
});
