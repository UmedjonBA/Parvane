import { describe, expect, it } from 'vitest';

import {
  droppedCardPlace, inlineKeyAction, nextNoteTitle, noteCardAction, notePreviewLines, relinkNoteCards,
} from './notesCanvasNote';

describe('noteCardAction', () => {
  it('текст найденной заметки правится по тексту карточки и по команде', () => {
    expect(noteCardAction('found', 'body')).toBe('editBody');
    expect(noteCardAction('found', 'command')).toBe('editBody');
  });

  it('шапка найденной заметки правит название', () => {
    expect(noteCardAction('found', 'title')).toBe('editTitle');
  });

  it('название заметки дня не меняется, текст правится', () => {
    expect(noteCardAction('found', 'title', true)).toBe('none');
    expect(noteCardAction('found', 'body', true)).toBe('editBody');
  });

  it('карточка заметки, которой нет, не правится, команда предлагает создать', () => {
    expect(noteCardAction('missing', 'body')).toBe('none');
    expect(noteCardAction('missing', 'title')).toBe('none');
    expect(noteCardAction('missing', 'command')).toBe('create');
  });

  it('пока хранилище читается, карточка не правится и заметка не создаётся', () => {
    expect(noteCardAction('loading', 'body')).toBe('none');
    expect(noteCardAction('loading', 'title')).toBe('none');
    expect(noteCardAction('loading', 'command')).toBe('none');
  });
});

describe('nextNoteTitle', () => {
  it('убирает пробелы по краям', () => {
    expect(nextNoteTitle('  Сервер  ', 'Старое')).toBe('Сервер');
  });

  it('пустое название отклоняется', () => {
    expect(nextNoteTitle('', 'Старое')).toBeUndefined();
    expect(nextNoteTitle('   ', 'Старое')).toBeUndefined();
  });

  it('прежнее название — не переименование', () => {
    expect(nextNoteTitle('Старое', 'Старое')).toBeUndefined();
    expect(nextNoteTitle(' Старое ', 'Старое')).toBeUndefined();
  });

  it('смена регистра — переименование', () => {
    expect(nextNoteTitle('старое', 'Старое')).toBe('старое');
  });
});

describe('inlineKeyAction', () => {
  it('Escape отменяет любую правку', () => {
    expect(inlineKeyAction('note', { key: 'Escape' })).toBe('cancel');
    expect(inlineKeyAction('title', { key: 'Escape' })).toBe('cancel');
    expect(inlineKeyAction('node', { key: 'Escape' })).toBe('cancel');
  });

  it('в тексте заметки Enter — новая строка, сохраняет Ctrl+Enter и Cmd+Enter', () => {
    expect(inlineKeyAction('note', { key: 'Enter' })).toBeUndefined();
    expect(inlineKeyAction('note', { key: 'Enter', shiftKey: true })).toBeUndefined();
    expect(inlineKeyAction('note', { key: 'Enter', ctrlKey: true })).toBe('save');
    expect(inlineKeyAction('note', { key: 'Enter', metaKey: true })).toBe('save');
  });

  it('название и текст карточки сохраняет Enter, Shift+Enter — новая строка', () => {
    expect(inlineKeyAction('title', { key: 'Enter' })).toBe('save');
    expect(inlineKeyAction('edge', { key: 'Enter' })).toBe('save');
    expect(inlineKeyAction('node', { key: 'Enter' })).toBe('save');
    expect(inlineKeyAction('node', { key: 'Enter', shiftKey: true })).toBeUndefined();
  });

  it('Enter при наборе иероглифов ничего не сохраняет', () => {
    expect(inlineKeyAction('title', { key: 'Enter', isComposing: true })).toBeUndefined();
    expect(inlineKeyAction('note', { key: 'Enter', ctrlKey: true, isComposing: true })).toBeUndefined();
  });

  it('прочие клавиши — обычный ввод', () => {
    expect(inlineKeyAction('note', { key: 'z', ctrlKey: true })).toBeUndefined();
    expect(inlineKeyAction('title', { key: 'a' })).toBeUndefined();
  });
});

describe('notePreviewLines', () => {
  it('прячет заголовок с названием, пустые строки и метки пунктов', () => {
    const body = '# Сервер\n\nБюджетный сервер. См. [[Курс]]\n\n- [ ] заказать блок ^tab12cd\n- проверить GPU\n## Итог';
    expect(notePreviewLines(body, 'Сервер', 7)).toEqual([
      'Бюджетный сервер. См. [[Курс]]', '• заказать блок', '• проверить GPU', 'Итог',
    ]);
  });

  it('показывает не больше заданного числа строк', () => {
    expect(notePreviewLines('а\nб\nв\nг', 'Заметка', 2)).toEqual(['а', 'б']);
  });

  it('пустой текст — пустой список', () => {
    expect(notePreviewLines('# Заметка\n\n', 'заметка', 7)).toEqual([]);
  });
});

describe('droppedCardPlace', () => {
  const at = { x: 400, y: 300 };

  it('карточка встаёт за концом стрелки по её ходу, на сетке', () => {
    expect(droppedCardPlace(at, 'right', 250, 140, 20)).toEqual({ x: 400, y: 240 });
    expect(droppedCardPlace(at, 'left', 250, 140, 20)).toEqual({ x: 160, y: 240 });
    expect(droppedCardPlace(at, 'bottom', 250, 140, 20)).toEqual({ x: 280, y: 300 });
    expect(droppedCardPlace(at, 'top', 250, 140, 20)).toEqual({ x: 280, y: 160 });
  });
});

describe('relinkNoteCards', () => {
  const card = (id: string, file: string, pvNote?: string) => ({
    id, type: 'file', x: 0, y: 0, width: 250, height: 140, file, ...(pvNote ? { pvNote } : {}),
  });
  const doc = {
    nodes: [
      card('a', 'Идея.md', 'n1'),
      card('b', 'Проекты/идея.md'),
      card('c', 'План.md', 'n2'),
      {
        id: 't', type: 'text', x: 0, y: 0, width: 250, height: 60, text: 'Идея',
      },
    ],
    edges: [],
  };

  it('карточки удалённой заметки указывают на новую: идентификатор и название в пути', () => {
    const next = relinkNoteCards(doc, 'n1', 'Идея', 'n9', 'Идея 2');
    expect(next.nodes.map((node) => [node.file, node.pvNote])).toEqual([
      ['Идея 2.md', 'n9'], ['Проекты/Идея 2.md', 'n9'], ['План.md', 'n2'], [undefined, undefined],
    ]);
  });

  it('название прежнее — путь не меняется, идентификатор новый', () => {
    const next = relinkNoteCards(doc, 'n1', 'Идея', 'n9', 'Идея');
    expect(next.nodes[0]).toMatchObject({ file: 'Идея.md', pvNote: 'n9' });
    expect(next.nodes[2]).toBe(doc.nodes[2]);
  });

  it('карточек заметки нет — прежний документ', () => {
    expect(relinkNoteCards(doc, 'n5', 'Другое', 'n9', 'Другое')).toBe(doc);
  });
});
