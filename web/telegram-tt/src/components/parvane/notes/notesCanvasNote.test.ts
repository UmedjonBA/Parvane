import { describe, expect, it } from 'vitest';

import {
  inlineKeyAction, nextNoteTitle, noteCardAction, notePreviewLines,
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
