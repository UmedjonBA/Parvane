// Parvane, раздел «Знания»: отмена и возврат правок холста. Документы неизменяемы, поэтому шаг истории —
// просто ссылка на прежний документ. Чистые функции, без UI.

import type { CanvasDoc } from './notesCanvas';

export type CanvasHistory = { past: CanvasDoc[]; future: CanvasDoc[] };
export type CanvasHistoryMove = { history: CanvasHistory; doc: CanvasDoc };

export const CANVAS_HISTORY_LIMIT = 100;

export function createHistory(): CanvasHistory {
  return { past: [], future: [] };
}

// Новый шаг: `before` — документ до правки. Возврат («вперёд») после новой правки невозможен; шагов
// хранится не больше `limit`, самые старые забываются
export function recordStep(history: CanvasHistory, before: CanvasDoc, limit = CANVAS_HISTORY_LIMIT): CanvasHistory {
  return { past: [...history.past, before].slice(-limit), future: [] };
}

// Отмена: `current` — документ на экране, он уходит в «вернуть». Отменять нечего — `undefined`
export function undoStep(history: CanvasHistory, current: CanvasDoc): CanvasHistoryMove | undefined {
  if (!history.past.length) return undefined;
  const doc = history.past[history.past.length - 1];
  return { history: { past: history.past.slice(0, -1), future: [current, ...history.future] }, doc };
}

export function redoStep(history: CanvasHistory, current: CanvasDoc): CanvasHistoryMove | undefined {
  if (!history.future.length) return undefined;
  const [doc, ...future] = history.future;
  return { history: { past: [...history.past, current], future }, doc };
}

// Последний шаг забывается совсем, без «вернуть»: так уходит новая карточка, оставленная пустой
export function dropStep(history: CanvasHistory): CanvasHistoryMove | undefined {
  if (!history.past.length) return undefined;
  return { history: { ...history, past: history.past.slice(0, -1) }, doc: history.past[history.past.length - 1] };
}
