import { describe, expect, it } from 'vitest';

import type { BoardRect, BoardView } from './boardView';

import { revealRects } from './boardView';

const WIDTH = 1000;
const HEIGHT = 700;
const TOP = 60;
const BOTTOM = 20;
const SIDE = 20;

function onScreen(view: BoardView, rect: BoardRect) {
  return {
    left: rect.x * view.scale + view.x,
    top: rect.y * view.scale + view.y,
    right: (rect.x + rect.width) * view.scale + view.x,
    bottom: (rect.y + rect.height) * view.scale + view.y,
  };
}

function isOnField(view: BoardView, rect: BoardRect) {
  const box = onScreen(view, rect);
  const slack = 0.001;
  return box.left >= SIDE - slack && box.right <= WIDTH - SIDE + slack
    && box.top >= TOP - slack && box.bottom <= HEIGHT - BOTTOM + slack;
}

describe('revealRects', () => {
  const view: BoardView = { scale: 1, x: 100, y: 100 };

  it('прямоугольники уже на поле — вид тот же', () => {
    const rects = [{ x: 0, y: 0, width: 250, height: 140 }, { x: 500, y: 300, width: 250, height: 140 }];
    expect(revealRects(view, rects, WIDTH, HEIGHT, TOP, BOTTOM)).toBe(view);
    expect(revealRects(view, [], WIDTH, HEIGHT, TOP, BOTTOM)).toBe(view);
  });

  it('прямоугольник под панелью инструментов считается скрытым', () => {
    const rect = { x: 0, y: -80, width: 250, height: 140 };
    const next = revealRects(view, [rect], WIDTH, HEIGHT, TOP, BOTTOM);
    expect(next).not.toBe(view);
    expect(isOnField(next, rect)).toBe(true);
  });

  it('прямоугольник за краем — вид отъезжает так, что видно и его, и прежнее поле', () => {
    const far = { x: 2400, y: 1500, width: 250, height: 140 };
    const before = { x: 0, y: 0, width: 250, height: 140 };
    const next = revealRects(view, [far], WIDTH, HEIGHT, TOP, BOTTOM);
    expect(next.scale).toBeLessThan(1);
    expect(isOnField(next, far)).toBe(true);
    expect(isOnField(next, before)).toBe(true);
  });

  it('приближенный вид после показа не приближается сильнее', () => {
    const zoomed: BoardView = { scale: 2, x: 0, y: 0 };
    const next = revealRects(zoomed, [{ x: 900, y: 0, width: 250, height: 140 }], WIDTH, HEIGHT, TOP, BOTTOM);
    expect(next.scale).toBeLessThanOrEqual(2);
  });
});
