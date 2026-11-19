import type { CanvasDoc, CanvasNode } from './notesCanvas';

import { CANVAS_DEFAULT_NODE_WIDTH, newCanvasId } from './notesCanvas';
import { CANVAS_GRID, snapTo } from './notesCanvasEdit';
import { GRAPH_NOTE_FIELD } from './notesCanvasGraph';

// «Добавить на холст» из меню заметки (доски `XpNotes`, `ZdNotesX`): карточка заметки встаёт справа от всего, что
// уже есть на холсте, вровень с верхним краем. Заметка, уже лежащая на холсте, второй раз не добавляется

// Высота карточки заметки — как у карточки, добавленной на самом холсте
export const NOTE_CARD_HEIGHT = 140;
const GAP = 6 * CANVAS_GRID;

export function addNoteToCanvas(doc: CanvasDoc, title: string, noteId: string, makeId = newCanvasId) {
  const existing = doc.nodes.find((node) => node.type === 'file' && (
    node[GRAPH_NOTE_FIELD] === noteId || node.file === `${title}.md`
  ));
  if (existing) return { doc, id: existing.id, isAdded: false };
  const right = doc.nodes.reduce((max, node) => Math.max(max, node.x + node.width), -Infinity);
  const top = doc.nodes.reduce((min, node) => Math.min(min, node.y), Infinity);
  const card: CanvasNode = {
    id: makeId(),
    type: 'file',
    x: doc.nodes.length ? snapTo(right + GAP) : 0,
    y: doc.nodes.length ? snapTo(top) : 0,
    width: CANVAS_DEFAULT_NODE_WIDTH,
    height: NOTE_CARD_HEIGHT,
    file: `${title}.md`,
    [GRAPH_NOTE_FIELD]: noteId,
  };
  return { doc: { ...doc, nodes: [...doc.nodes, card] }, id: card.id, isAdded: true };
}
