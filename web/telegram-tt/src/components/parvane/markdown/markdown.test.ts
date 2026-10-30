import { describe, expect, it } from 'vitest';

import {
  embedNames, parseInline, parseMarkdown, renameEmbeds,
} from './markdown';

describe('markdown', () => {
  it('блоки: заголовок-название пропускается, списки, цитата, код, встроенный файл; номера строк — исходные', () => {
    const text = [
      '---', 'tags: [a]', '---',
      '# Поход', '', '## Вещи', '- палатка', '  - колышки', '- [x] спальник', '1. выйти', '2. дойти',
      '> мысль', '> дальше', '', '```', 'code # не заголовок', '```', '---', '![[карта.png]]', 'строка', 'вторая',
    ].join('\n');
    expect(parseMarkdown(text, 'Поход')).toEqual([
      { type: 'heading', level: 2, text: 'Вещи', line: 5 },
      {
        type: 'list',
        isOrdered: false,
        line: 6,
        items: [
          { text: 'палатка', depth: 0, line: 6 },
          { text: 'колышки', depth: 1, line: 7 },
          {
            text: 'спальник', depth: 0, isChecked: true, line: 8,
          },
        ],
      },
      {
        type: 'list',
        isOrdered: true,
        line: 9,
        items: [{ text: 'выйти', depth: 0, line: 9 }, { text: 'дойти', depth: 0, line: 10 }],
      },
      { type: 'quote', text: 'мысль\nдальше', line: 11 },
      { type: 'code', text: 'code # не заголовок', line: 14 },
      { type: 'rule', line: 17 },
      { type: 'embed', name: 'карта.png', line: 18 },
      { type: 'paragraph', text: 'строка\nвторая', line: 19 },
    ]);
  });

  it('таблица: заголовок, выравнивание, `\\|` внутри ячейки, недостающие ячейки — пустые', () => {
    const text = ['| Имя | Кол-во |', '|:---|---:|', '| a \\| b | 2 |', '| c |', '', 'после'].join('\n');
    expect(parseMarkdown(text)).toEqual([
      {
        type: 'table',
        header: ['Имя', 'Кол-во'],
        align: ['left', 'right'],
        rows: [['a | b', '2'], ['c', '']],
        line: 0,
      },
      { type: 'paragraph', text: 'после', line: 5 },
    ]);
  });

  it('встроенные файлы: облако по имени и пути, внешний адрес не загружается', () => {
    const text = ['![[фото.jpg|подпись]]', '![карта](папка/карта%201.png)', '![x](https://site/a.png)', '![[фото.jpg]]']
      .join('\n');
    expect(parseMarkdown(text)).toEqual([
      {
        type: 'embed', name: 'фото.jpg', alt: 'подпись', line: 0,
      },
      {
        type: 'embed', name: 'папка/карта 1.png', alt: 'карта', line: 1,
      },
      {
        type: 'embed', name: 'https://site/a.png', alt: 'x', url: 'https://site/a.png', line: 2,
      },
      { type: 'embed', name: 'фото.jpg', line: 3 },
    ]);
    expect(embedNames(text)).toEqual(['фото.jpg', 'папка/карта 1.png']);
    expect(renameEmbeds(text, new Map([['фото.jpg', 'фото (2).jpg'], ['папка/карта 1.png', 'карта 1.png']])))
      .toBe(['![[фото (2).jpg|подпись]]', '![карта](%D0%BA%D0%B0%D1%80%D1%82%D0%B0%201.png)',
        '![x](https://site/a.png)', '![[фото (2).jpg]]'].join('\n'));
  });

  it('строка: жирный, курсив, зачёркнутый, код, ссылки, заметки, теги; опасная ссылка — текстом', () => {
    expect(parseInline('**a** _b_ ~~s~~ `c` [d](https://x.y) [[E|е]] #tag [f](javascript:1)')).toEqual([
      { type: 'bold', text: 'a' },
      { type: 'text', text: ' ' },
      { type: 'italic', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'strike', text: 's' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'd', url: 'https://x.y' },
      { type: 'text', text: ' ' },
      { type: 'note', text: 'е', target: 'E' },
      { type: 'text', text: ' ' },
      { type: 'tag', text: '#tag' },
      { type: 'text', text: ' f' },
    ]);
  });

  it('звёздочки внутри слова — не курсив', () => {
    expect(parseInline('2*3*4')).toEqual([{ type: 'text', text: '2*3*4' }]);
  });

  it('длинная строка без закрывающих знаков разбирается быстро (не квадратично)', () => {
    const started = Date.now();
    parseMarkdown(`![a](${'b'.repeat(64000)}`);
    parseMarkdown('['.repeat(64000));
    parseInline('['.repeat(64000));
    parseInline(`[a](${'b'.repeat(64000)}`);
    renameEmbeds(`![a](${'b'.repeat(64000)}`, new Map());
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
