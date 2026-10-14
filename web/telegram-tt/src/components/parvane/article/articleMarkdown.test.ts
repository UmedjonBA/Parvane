import { describe, expect, it } from 'vitest';

import { parseArticle, parseArticleInline } from './articleMarkdown';

describe('articleMarkdown', () => {
  it('блоки: заголовок-название пропускается, списки, цитата, код, картинка', () => {
    const text = [
      '---', 'tags: [a]', '---',
      '# Поход', '', '## Вещи', '- палатка', '  - колышки', '- [x] спальник', '1. выйти', '2. дойти',
      '> мысль', '> дальше', '', '```', 'code # не заголовок', '```', '---', '![[карта.png]]', 'строка', 'вторая',
    ].join('\n');
    expect(parseArticle(text, 'Поход')).toEqual([
      { type: 'heading', level: 2, text: 'Вещи' },
      {
        type: 'list',
        isOrdered: false,
        items: [
          { text: 'палатка', depth: 0 },
          { text: 'колышки', depth: 1 },
          { text: 'спальник', depth: 0, isChecked: true },
        ],
      },
      { type: 'list', isOrdered: true, items: [{ text: 'выйти', depth: 0 }, { text: 'дойти', depth: 0 }] },
      { type: 'quote', text: 'мысль\nдальше' },
      { type: 'code', text: 'code # не заголовок' },
      { type: 'rule' },
      { type: 'image', name: 'карта.png' },
      { type: 'paragraph', text: 'строка\nвторая' },
    ]);
  });

  it('строка: жирный, курсив, код, ссылки, заметки, теги; опасная ссылка — текстом', () => {
    expect(parseArticleInline('**a** _b_ `c` [d](https://x.y) [[E|е]] #tag [f](javascript:1)')).toEqual([
      { type: 'bold', text: 'a' },
      { type: 'text', text: ' ' },
      { type: 'italic', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'd', url: 'https://x.y' },
      { type: 'text', text: ' ' },
      { type: 'note', text: 'е' },
      { type: 'text', text: ' ' },
      { type: 'tag', text: '#tag' },
      { type: 'text', text: ' f' },
    ]);
  });

  it('звёздочки внутри слова — не курсив', () => {
    expect(parseArticleInline('2*3*4')).toEqual([{ type: 'text', text: '2*3*4' }]);
  });
});
