import { describe, expect, it } from 'vitest';

import { mergeNotes } from './notesMerge';

const BASE = '# План\n- [ ] Блок питания\n- [ ] Забрать платы\n\nСвязано: [[Сервер X99]]\n';

type Row = [name: string, base: string, mine: string, theirs: string, text: string, hasConflict?: true];

function run(rows: Row[]) {
  rows.forEach(([name, base, mine, theirs, text, hasConflict]) => {
    it(name, () => {
      expect(mergeNotes(base, mine, theirs)).toEqual({ text, hasConflict: Boolean(hasConflict) });
    });
  });
}

describe('слияние заметки: без конфликта', () => {
  run([
    ['никто не менял', BASE, BASE, BASE, BASE],
    ['менял только я', BASE, BASE.replace('[ ] Блок', '[x] Блок'), BASE, BASE.replace('[ ] Блок', '[x] Блок')],
    ['меняли только они', BASE, BASE, BASE.replace('Забрать платы', 'Забрать платы до пт'),
      BASE.replace('Забрать платы', 'Забрать платы до пт')],
    ['разные места', BASE,
      BASE.replace('[ ] Блок', '[x] Блок'),
      BASE.replace('Связано:', 'См. также:'),
      '# План\n- [x] Блок питания\n- [ ] Забрать платы\n\nСм. также: [[Сервер X99]]\n'],
    ['я дописал в начало, они в конец', BASE, `Вступление\n${BASE}`, `${BASE}- [ ] Проверить GPU\n`,
      `Вступление\n${BASE}- [ ] Проверить GPU\n`],
    ['я удалил строку, они дописали в конец', BASE,
      BASE.replace('- [ ] Блок питания\n', ''), `${BASE}Итог\n`,
      '# План\n- [ ] Забрать платы\n\nСвязано: [[Сервер X99]]\nИтог\n'],
    ['одна и та же правка', BASE,
      BASE.replace('[ ] Блок', '[x] Блок'), BASE.replace('[ ] Блок', '[x] Блок'),
      BASE.replace('[ ] Блок', '[x] Блок')],
    ['одинаковая вставка в одно место', 'а\nб', 'а\nновая\nб', 'а\nновая\nб', 'а\nновая\nб'],
    ['одинаковое удаление', 'а\nб\nв', 'а\nв', 'а\nв', 'а\nв'],
    ['вставки в разные места', 'а\nб\nв', 'а\nмоя\nб\nв', 'а\nб\nих\nв', 'а\nмоя\nб\nих\nв'],
    ['повторяющиеся строки', '- [ ] \n- [ ] \n- [ ] \nконец', '- [x] \n- [ ] \n- [ ] \nконец',
      '- [ ] \n- [ ] \n- [ ] \nконец\nещё', '- [x] \n- [ ] \n- [ ] \nконец\nещё'],
    ['пустая основа, пишу только я', '', 'Мой текст\n', '', 'Мой текст\n'],
    ['пустая основа, пишут только они', '', '', 'Их текст', 'Их текст'],
    ['пустая основа, написали одно и то же', '', 'Текст\n', 'Текст\n', 'Текст\n'],
    ['я стёр всё, они не трогали', BASE, '', BASE, ''],
    ['они стёрли всё, я не трогал', BASE, BASE, '', ''],
  ]);
});

describe('слияние заметки: конфликт', () => {
  run([
    ['одна строка изменена по-разному', BASE,
      BASE.replace('Забрать платы', 'Забрать платы до пт'), BASE.replace('Забрать платы', 'Забрать платы завтра'),
      BASE.replace('Забрать платы', 'Забрать платы до пт'), true],
    ['соседние строки', 'а\nб\nв', 'А\nб\nв', 'а\nБ\nв', 'А\nб\nв', true],
    ['вставка в одно место с разным текстом', 'а\nб', 'а\nмоя\nб', 'а\nих\nб', 'а\nмоя\nб', true],
    ['я удалил, они правили', BASE,
      BASE.replace('- [ ] Забрать платы\n', ''), BASE.replace('Забрать платы', 'Забрать платы до пт'),
      BASE.replace('- [ ] Забрать платы\n', ''), true],
    ['я правил, они удалили', BASE,
      BASE.replace('Забрать платы', 'Забрать платы до пт'), BASE.replace('- [ ] Забрать платы\n', ''),
      BASE.replace('Забрать платы', 'Забрать платы до пт'), true],
    ['пустая основа, написали разное', '', 'Моя заметка\n', 'Их заметка\n', 'Моя заметка\n', true],
    ['правка рядом с общей вставкой', 'а\nб\nв\nг\nд', 'а\nновая\nб\nв\nг\nД', 'А\nновая\nб\nв\nг\nд',
      'а\nновая\nб\nв\nг\nД', true],
    ['я стёр всё, они правили', BASE, '', BASE.replace('[ ] Блок', '[x] Блок'), '', true],
  ]);
});

describe('слияние заметки: переводы строк', () => {
  run([
    ['CRLF у них, правки в разных местах', 'а\nб\nв\n', 'А\nб\nв\n', 'а\r\nб\r\nВ\r\n', 'А\nб\nВ\n'],
    ['CRLF у всех, менял только я', 'а\r\nб\r\n', 'а\r\nБ\r\n', 'а\r\nб\r\n', 'а\nБ\n'],
    ['разница только в CRLF — не правка', 'а\nб', 'а\r\nб', 'а\nб', 'а\nб'],
    ['у меня есть последний перевод строки, у них нет', 'а\nб\nв', 'А\nб\nв\n', 'а\nб\nВ', 'А\nб\nВ\n'],
    ['у меня нет последнего перевода строки, у них есть', 'а\nб\nв\n', 'А\nб\nв', 'а\nб\nВ\n', 'А\nб\nВ'],
    ['они только добавили последний перевод строки', 'а\nб', 'а\nб', 'а\nб\n', 'а\nб\n'],
    ['я только убрал последний перевод строки', 'а\nб\n', 'а\nб', 'а\nб\n', 'а\nб'],
    ['пустые строки в конце сохраняются', 'а\n\n\n', 'а\n\n\n', 'А\n\n\n', 'А\n\n\n'],
    ['конфликт: текст мой, переводы строк приведены', 'а\r\n', 'моя\r\n', 'их\r\n', 'моя\n', true],
  ]);
});

describe('слияние заметки: большие тексты', () => {
  const makeLines = (count: number, prefix: string) => (
    Array.from({ length: count }, (_, index) => `${prefix} ${index}`)
  );

  it('несколько тысяч строк, правки в разных концах', () => {
    const base = makeLines(3000, 'строка');
    const mine = [...base];
    mine[5] = 'моя правка';
    mine.splice(100, 0, 'моя вставка');
    const theirs = [...base];
    theirs[2990] = 'их правка';
    theirs.splice(2500, 2);
    const expected = [...mine];
    expected[2991] = 'их правка';
    expected.splice(2501, 2);
    expect(mergeNotes(base.join('\n'), mine.join('\n'), theirs.join('\n'))).toEqual({
      text: expected.join('\n'), hasConflict: false,
    });
  });

  it('слишком большое сравнение — конфликт без построчного разбора', () => {
    const base = makeLines(2100, 'основа').join('\n');
    const mine = makeLines(2100, 'моя').join('\n');
    const theirs = `${base}\nих строка`;
    expect(mergeNotes(base, mine, theirs)).toEqual({ text: mine, hasConflict: true });
    expect(mergeNotes(base, mine, mine)).toEqual({ text: mine, hasConflict: false });
    expect(mergeNotes(base, base, theirs)).toEqual({ text: theirs, hasConflict: false });
    expect(mergeNotes(base, mine, base)).toEqual({ text: mine, hasConflict: false });
  });
});
