// Parvane, «Заметки»: сводка холста для списка холстов (доски `RpNotes`, `ZdNotesX`) — число карточек и стрелок
// и миниатюра: до `PREVIEW_CARDS` крупных карточек, вписанных в рамку плитки (доли от 0 до 1)

import type { CanvasDoc } from './notesCanvas';

import { boundsOf, parseCanvas } from './notesCanvas';
import { fileNameOfPath, noteTitleOfPath } from './notesCanvasFiles';

export type CanvasPreviewCard = { x: number; y: number; width: number; height: number; color?: string };
// `names` — то, по чему холст находится поиском, кроме своего названия: названия карточек заметок и файлов,
// тексты карточек, названия групп, адреса ссылок
export type CanvasSummary = { cards: number; arrows: number; preview: CanvasPreviewCard[]; names: string[] };

const PREVIEW_CARDS = 4;
// Карточка миниатюры не тоньше этой доли рамки — иначе на плитке её не видно
const PREVIEW_MIN_SIZE = 0.08;

export function summarizeCanvas(text: string): CanvasSummary {
  return summarizeCanvasDoc(parseCanvas(text).doc);
}

export function summarizeCanvasDoc(doc: CanvasDoc): CanvasSummary {
  const cards = doc.nodes.filter(({ type }) => type !== 'group');
  const names = doc.nodes.map((node) => (
    noteTitleOfPath(node.file) || (node.file ? fileNameOfPath(node.file) : '')
    || node.label || node.text || node.url || ''
  )).filter(Boolean);
  const bounds = boundsOf(doc);
  if (!bounds || !cards.length) return { cards: cards.length, arrows: doc.edges.length, preview: [], names };
  // Рамка квадратна по большей стороне: пропорции карточек не искажаются
  const side = Math.max(bounds.width, bounds.height) || 1;
  const left = bounds.x - (side - bounds.width) / 2;
  const top = bounds.y - (side - bounds.height) / 2;
  const preview = [...cards]
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, PREVIEW_CARDS)
    .map((node) => ({
      x: (node.x - left) / side,
      y: (node.y - top) / side,
      width: Math.max(PREVIEW_MIN_SIZE, node.width / side),
      height: Math.max(PREVIEW_MIN_SIZE, node.height / side),
      color: node.color,
    }));
  return {
    cards: cards.length, arrows: doc.edges.length, preview, names,
  };
}

/** Поиск по холстам (доска `RpNotes`): строка ищется в названии холста и в названиях и текстах его карточек;
 * регистр и «ё» не различаются. Пустая строка подходит любому холсту. */
export function isCanvasFound(title: string, summary: Pick<CanvasSummary, 'names'>, query: string) {
  const wanted = normalizeSearch(query);
  if (!wanted) return true;
  return [title, ...summary.names].some((name) => normalizeSearch(name).includes(wanted));
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase().replace(/ё/g, 'е');
}
