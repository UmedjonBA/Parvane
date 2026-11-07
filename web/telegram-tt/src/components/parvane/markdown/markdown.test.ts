import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectTexts, embedNames, MD_BOLD, MD_CODE, MD_ITALIC, MD_MARK, MD_STRIKE, MD_UNDERLINE, parseInline, parseMarkdown,
  renameEmbeds,
} from './markdown';

// Общий образец разбора web ↔ ядро desktop/android (тестовый файл пользователя 6 ноя 2026)
const FIXTURE_DIR = resolve(__dirname, '../../../../../../conformance/markdown');
const FIXTURE = resolve(FIXTURE_DIR, 'all-constructs.md');
const EXPECTED = resolve(FIXTURE_DIR, 'all-constructs.expected.json');

function buildExpected(markdown: string) {
  const blocks = parseMarkdown(markdown, 'Тест');
  return JSON.parse(JSON.stringify({
    blocks,
    inlines: collectTexts(blocks).map((text) => ({ text, parts: parseInline(text) })),
  }));
}

describe('markdown', () => {
  it('строка, начатая табуляцией, — код (табуляция до 4 колонок, как в CommonMark); в списке — уровень', () => {
    const blocks = parseMarkdown('абзац\n\n\tкод с табуляцией\n\n- пункт\n\t- вложенный');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'code', 'list']);
    expect(blocks[1].type === 'code' && blocks[1].text).toBe('код с табуляцией');
    expect(blocks[2].type === 'list' && blocks[2].items.map((item) => item.depth)).toEqual([0, 1]);
  });

  it('блоки: заголовок-название пропускается, списки, цитата, код, встроенный файл; номера строк — исходные', () => {
    const text = [
      '---', 'tags: [a]', '---',
      '# Поход', '', '## Вещи', '- палатка', '  - колышки', '- [x] спальник', '1. выйти', '2. дойти',
      '> мысль', '> дальше', '', '```', 'code # не заголовок', '```', '---', '![[карта.png]]', 'строка', 'вторая',
    ].join('\n');
    expect(parseMarkdown(text, 'Поход')).toEqual([
      {
        type: 'heading', level: 2, text: 'Вещи', id: 'вещи', line: 5,
      },
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
          {
            text: 'выйти', depth: 0, number: 1, line: 9,
          },
          {
            text: 'дойти', depth: 0, number: 2, line: 10,
          },
        ],
      },
      {
        type: 'quote', blocks: [{ type: 'paragraph', text: 'мысль\nдальше', line: 11 }], line: 11,
      },
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

  it('строка: начертания, вложенность, ссылки, заметки, теги; опасная ссылка — текстом', () => {
    expect(parseInline('**a *b*** _c_ ~~s~~ ==m== <u>u</u> `c` [d](https://x.y) [[E|е]] #tag [f](javascript:1)'))
      .toEqual([
        { type: 'text', text: 'a ', style: MD_BOLD },
        { type: 'text', text: 'b', style: MD_BOLD | MD_ITALIC },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'c', style: MD_ITALIC },
        { type: 'text', text: ' ' },
        { type: 'text', text: 's', style: MD_STRIKE },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'm', style: MD_MARK },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'u', style: MD_UNDERLINE },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'c', style: MD_CODE },
        { type: 'text', text: ' ' },
        { type: 'link', text: 'd', url: 'https://x.y' },
        { type: 'text', text: ' ' },
        { type: 'note', text: 'е', target: 'E' },
        { type: 'text', text: ' ' },
        { type: 'tag', text: '#tag' },
        { type: 'text', text: ' f' },
      ]);
  });

  it('звёздочки между пробелами и подчёркивания внутри слова — не курсив; экранирование', () => {
    expect(parseInline('2 * 3 * 4 snake_case_x \\*x\\*'))
      .toEqual([{ type: 'text', text: '2 * 3 * 4 snake_case_x *x*' }]);
    expect(parseInline('#123 #тег')).toEqual([{ type: 'text', text: '#123 ' }, { type: 'tag', text: '#тег' }]);
  });

  it('длинная строка без закрывающих знаков разбирается быстро (не квадратично)', () => {
    const started = Date.now();
    parseMarkdown(`![a](${'b'.repeat(64000)}`);
    parseMarkdown('['.repeat(64000));
    parseInline('['.repeat(64000));
    parseInline('*'.repeat(64000));
    parseInline('* a '.repeat(16000));
    parseInline('`` ` '.repeat(16000));
    parseInline(`[a](${'b'.repeat(64000)}`);
    parseMarkdown('> '.repeat(5000));
    parseMarkdown(Array.from({ length: 2000 }, (_, i) => `${' '.repeat(i % 40)}- x`).join('\n'));
    renameEmbeds(`![a](${'b'.repeat(64000)}`, new Map());
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('общий образец разбора совпадает с conformance/markdown (ядро desktop/android сверяет тот же файл)', () => {
    const expected = buildExpected(readFileSync(FIXTURE, 'utf8'));
    if (process.env.PARVANE_WRITE_MD_FIXTURE || !existsSync(EXPECTED)) {
      writeFileSync(EXPECTED, `${JSON.stringify(expected, undefined, 1)}\n`);
    }
    expect(expected).toEqual(JSON.parse(readFileSync(EXPECTED, 'utf8')));
  });
});
