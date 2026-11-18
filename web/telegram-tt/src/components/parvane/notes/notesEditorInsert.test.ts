import { describe, expect, it } from 'vitest';

import { applyEditorTool, completeOpenLink, findOpenLink } from './notesEditorInsert';

const at = (text: string, from: number, to = from) => ({ text, from, to });

describe('заметки: кнопки разметки', () => {
  it('заголовок, задача, выноска и список встают в начало строки с курсором', () => {
    expect(applyEditorTool(at('первая\nвторая', 9), 'heading')).toEqual(at('первая\n# вторая', 11));
    expect(applyEditorTool(at('купить кабель', 3), 'task')).toEqual(at('- [ ] купить кабель', 9));
    expect(applyEditorTool(at('важно', 0), 'callout')).toEqual(at('> важно', 2));
    expect(applyEditorTool(at('', 0), 'list')).toEqual(at('- ', 2));
  });

  it('строчная разметка ставится каждой строке выделения', () => {
    expect(applyEditorTool(at('один\nдва\nтри', 2, 8), 'task')).toEqual(at('- [ ] один\n- [ ] два\nтри', 8, 20));
  });

  it('жирный и ссылка оборачивают выделение, без выделения курсор встаёт внутрь', () => {
    expect(applyEditorTool(at('порт открыт', 5, 11), 'bold')).toEqual(at('порт **открыт**', 7, 13));
    expect(applyEditorTool(at('см. ', 4), 'link')).toEqual(at('см. [[]]', 6));
  });

  it('код: в строке — кавычки, несколько строк и пустая строка — блок', () => {
    expect(applyEditorTool(at('узел wg0 готов', 5, 8), 'code')).toEqual(at('узел `wg0` готов', 6, 9));
    expect(applyEditorTool(at('', 0), 'code')).toEqual(at('```\n\n```', 4));
    expect(applyEditorTool(at('а\nб', 0, 3), 'code')).toEqual(at('```\nа\nб\n```', 4, 7));
  });
});

describe('заметки: подсказка для незакрытой ссылки', () => {
  it('находит начало названия после «[[»', () => {
    expect(findOpenLink('Правила — в [[nf', 16)).toEqual({ query: 'nf', from: 14 });
    expect(findOpenLink('см. [[', 6)).toEqual({ query: '', from: 6 });
  });

  it('закрытая ссылка, подпись и другая строка подсказку не дают', () => {
    expect(findOpenLink('см. [[Сервер]] и', 16)).toBeUndefined();
    expect(findOpenLink('см. [[Сервер|под', 16)).toBeUndefined();
    expect(findOpenLink('см. [[Сер\nвер', 13)).toBeUndefined();
    expect(findOpenLink('обычный текст', 5)).toBeUndefined();
  });

  it('название дописывается и ссылка закрывается, курсор — за ней', () => {
    expect(completeOpenLink(at('в [[nf и дальше', 6), 'nftables')).toEqual(at('в [[nftables]] и дальше', 14));
  });

  it('уже стоящее закрытие не удваивается', () => {
    expect(completeOpenLink(at('в [[nf]]', 6), 'nftables')).toEqual(at('в [[nftables]]', 14));
  });
});
