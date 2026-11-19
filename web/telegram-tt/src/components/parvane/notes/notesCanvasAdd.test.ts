import { describe, expect, it } from 'vitest';

import { createEmptyCanvas } from './notesCanvas';
import { addNoteToCanvas, NOTE_CARD_HEIGHT } from './notesCanvasAdd';
import { GRAPH_NOTE_FIELD } from './notesCanvasGraph';

const makeId = () => 'card';

describe('карточка заметки из меню заметки', () => {
  it('на пустой холст — в начало поля', () => {
    const { doc, isAdded } = addNoteToCanvas(createEmptyCanvas(), 'Сервер', 'n1', makeId);
    expect(isAdded).toBe(true);
    expect(doc.nodes).toEqual([{
      id: 'card',
      type: 'file',
      x: 0,
      y: 0,
      width: 250,
      height: NOTE_CARD_HEIGHT,
      file: 'Сервер.md',
      [GRAPH_NOTE_FIELD]: 'n1',
    }]);
  });

  it('справа от всего, вровень с верхним краем, по сетке', () => {
    const base = {
      ...createEmptyCanvas(),
      nodes: [
        {
          id: 'a', type: 'text', x: 13, y: 47, width: 100, height: 60,
        },
        {
          id: 'b', type: 'text', x: 200, y: -21, width: 103, height: 60,
        },
      ],
    };
    const { doc } = addNoteToCanvas(base, 'Сервер', 'n1', makeId);
    expect(doc.nodes[2]).toMatchObject({ x: 360, y: -20 });
  });

  it('заметка уже на холсте — второй карточки нет', () => {
    const first = addNoteToCanvas(createEmptyCanvas(), 'Сервер', 'n1', makeId);
    const second = addNoteToCanvas(first.doc, 'Сервер', 'n1', () => 'other');
    expect(second).toEqual({ doc: first.doc, id: 'card', isAdded: false });
  });
});
