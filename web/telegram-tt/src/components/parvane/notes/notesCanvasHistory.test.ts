import { describe, expect, it } from 'vitest';

import type { CanvasDoc } from './notesCanvas';

import {
  CANVAS_HISTORY_LIMIT, createHistory, dropStep, recordStep, redoStep, undoStep,
} from './notesCanvasHistory';

function docOf(count: number): CanvasDoc {
  return {
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, type: 'text', x: i, y: 0, width: 100, height: 60,
    })),
    edges: [],
  };
}

describe('история правок холста', () => {
  const [a, b, c] = [docOf(1), docOf(2), docOf(3)];

  it('пустая история ничего не отменяет и не возвращает', () => {
    const history = createHistory();
    expect(undoStep(history, a)).toBeUndefined();
    expect(redoStep(history, a)).toBeUndefined();
    expect(dropStep(history)).toBeUndefined();
  });

  it('отмена возвращает прежний документ, возврат — отменённый', () => {
    // a → b → c
    const history = recordStep(recordStep(createHistory(), a), b);
    const first = undoStep(history, c)!;
    expect(first.doc).toBe(b);
    const second = undoStep(first.history, first.doc)!;
    expect(second.doc).toBe(a);
    expect(undoStep(second.history, second.doc)).toBeUndefined();
    const forward = redoStep(second.history, second.doc)!;
    expect(forward.doc).toBe(b);
    const last = redoStep(forward.history, forward.doc)!;
    expect(last.doc).toBe(c);
    expect(redoStep(last.history, last.doc)).toBeUndefined();
    expect(last.history).toEqual(history);
  });

  it('новая правка после отмены стирает «вернуть»', () => {
    const undone = undoStep(recordStep(createHistory(), a), b)!;
    const next = recordStep(undone.history, undone.doc);
    expect(next.future).toEqual([]);
    expect(redoStep(next, c)).toBeUndefined();
    expect(undoStep(next, c)!.doc).toBe(a);
  });

  it('шагов не больше предела: старые забываются', () => {
    let history = createHistory();
    for (let i = 0; i < CANVAS_HISTORY_LIMIT + 5; i++) history = recordStep(history, docOf(i));
    expect(history.past).toHaveLength(CANVAS_HISTORY_LIMIT);
    expect(history.past[0].nodes).toHaveLength(5);
    expect(recordStep(recordStep(createHistory(), a, 1), b, 1).past).toEqual([b]);
  });

  it('забытый шаг не попадает в «вернуть»', () => {
    const history = recordStep(recordStep(createHistory(), a), b);
    const dropped = dropStep(history)!;
    expect(dropped.doc).toBe(b);
    expect(dropped.history).toEqual({ past: [a], future: [] });
  });
});
