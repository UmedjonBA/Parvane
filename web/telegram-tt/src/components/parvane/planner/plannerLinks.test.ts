import { describe, expect, it } from 'vitest';

import {
  formatDescriptionLine, formatPlainName, maskNameLinks, splitNameLinks, unmaskNameLinks,
} from './plannerLinks';

describe('планировщик: ссылки на заметки в названии записи', () => {
  it('название без ссылок — одна часть текста', () => {
    expect(splitNameLinks('Созвон команды')).toEqual([{ text: 'Созвон команды' }]);
    expect(splitNameLinks('')).toEqual([]);
  });

  it('ссылка показывает название заметки, остальное остаётся текстом', () => {
    expect(splitNameLinks('созвон [[Сервер X99]] в четверг')).toEqual([
      { text: 'созвон ' },
      { text: 'Сервер X99', note: 'Сервер X99' },
      { text: ' в четверг' },
    ]);
  });

  it('ссылка с подписью показывает подпись, а ведёт на заметку', () => {
    expect(splitNameLinks('[[Сервер X99|сервер]]')).toEqual([{ text: 'сервер', note: 'Сервер X99' }]);
    // Пустая подпись — название заметки
    expect(splitNameLinks('[[Parvane|]]')).toEqual([{ text: 'Parvane', note: 'Parvane' }]);
    expect(splitNameLinks('[[ Parvane | проект ]]')).toEqual([{ text: 'проект', note: 'Parvane' }]);
  });

  it('несколько ссылок подряд и в начале строки', () => {
    expect(splitNameLinks('[[А]][[Б|вторая]] и текст')).toEqual([
      { text: 'А', note: 'А' },
      { text: 'вторая', note: 'Б' },
      { text: ' и текст' },
    ]);
  });

  it('незакрытые, пустые и одинарные скобки остаются текстом', () => {
    expect(splitNameLinks('план [[без конца')).toEqual([{ text: 'план [[без конца' }]);
    expect(splitNameLinks('пусто [[]] и [[ ]]')).toEqual([{ text: 'пусто [[]] и [[ ]]' }]);
    expect(splitNameLinks('массив [1] и [2]')).toEqual([{ text: 'массив [1] и [2]' }]);
    expect(splitNameLinks('[[[Заметка]]]')).toEqual([
      { text: '[' }, { text: 'Заметка', note: 'Заметка' }, { text: ']' },
    ]);
  });

  it('название без разметки: подпись либо название заметки на месте ссылки', () => {
    expect(formatPlainName('созвон [[Сервер X99|сервер]] и [[Parvane]]')).toBe('созвон сервер и Parvane');
    expect(formatPlainName('Зарядка')).toBe('Зарядка');
  });

  it('строка описания для расписания: первая непустая, без разметки ссылок', () => {
    expect(formatDescriptionLine('будет тест\nвзять тетрадь')).toBe('будет тест');
    expect(formatDescriptionLine('\n  см. [[Конспект|конспект]] \nещё')).toBe('см. конспект');
    expect(formatDescriptionLine('')).toBe('');
    expect(formatDescriptionLine(undefined)).toBe('');
  });

  it('заглушки закрывают ссылки, не сдвигая остальной текст, и снимаются обратно', () => {
    const source = '[[Встреча завтра]] сб [[А|б]][[В]] 15:00';
    const { text, links } = maskNameLinks(source);
    expect(links).toEqual(['[[Встреча завтра]]', '[[А|б]]', '[[В]]']);
    expect(text).toHaveLength(source.length);
    expect(text).not.toMatch(/[[\]|]|завтра/);
    expect(text.slice(18, 22)).toBe(' сб ');
    expect(unmaskNameLinks(text, links)).toBe(source);
    // Часть строки (название без описания) возвращает только свои ссылки
    expect(unmaskNameLinks(text.slice(0, 18), links)).toBe('[[Встреча завтра]]');
    // Скобки без названия ссылкой не считаются
    expect(maskNameLinks('[[]] и [[ ]]')).toEqual({ text: '[[]] и [[ ]]', links: [] });
    expect(unmaskNameLinks('без ссылок', [])).toBe('без ссылок');
  });
});
