import { describe, expect, it } from 'vitest';

import type { NoteProperties, NoteSource, NoteTask } from './notesModel';

import {
  buildNotesIndex, dailyNoteTemplate, dailyNoteTitle, dedupeTaskMarkers, ensureTaskMarker, findTaskLine,
  normalizeNoteTitle, noteSearchText, parseNote, parseNoteCached, removeTaskLine, renameLinks, serializeNote,
  setTaskDone,
} from './notesModel';

function makeIds(...ids: string[]) {
  let next = 0;
  return () => ids[Math.min(next++, ids.length - 1)];
}

describe('заметки: ссылки', () => {
  const rows: [text: string, links: string[]][] = [
    ['Шпаргалка — [[Python: основы]]', ['Python: основы']],
    ['[[Курс ОГЭ|курс]] и [[Сервер X99]]', ['Курс ОГЭ', 'Сервер X99']],
    ['[[Parvane]] [[parvane]] [[ PARVANE |ещё раз]]', ['Parvane']],
    ['Код `[[не ссылка]]`, дальше [[Ссылка]]', ['Ссылка']],
    ['``код с ` и [[внутри]]`` [[снаружи]]', ['снаружи']],
    ['```\n[[в блоке]]\n```\n[[после блока]]', ['после блока']],
    ['~~~md\n[[в блоке]]\n```\n[[всё ещё в блоке]]\n~~~\n[[после]]', ['после']],
    ['[[]] [[ |пусто]] [[Одна]', []],
    ['- [ ] Ответить по серверу [[Сервер X99]] ^t7f3a', ['Сервер X99']],
    ['Без ссылок', []],
  ];
  rows.forEach(([text, links]) => {
    it(text, () => expect(parseNote(text).links).toEqual(links));
  });
});

describe('заметки: теги', () => {
  const rows: [text: string, tags: string[]][] = [
    ['Собрать банк задач #огэ', ['огэ']],
    ['#проект/parvane и #идея_1, #в-работе.', ['проект/parvane', 'идея_1', 'в-работе']],
    ['# Заголовок\n## Второй\n#тег-в-начале', ['тег-в-начале']],
    ['#Огэ #огэ #ОГЭ', ['Огэ']],
    ['Сайт https://example.ru/page#раздел и C#шарп', []],
    ['Задача №1 #1 и #2026, но #2026год', ['2026год']],
    ['Код `#нетег` и\n```\n#тоже-нет\n```\n#да', ['да']],
    ['[[Заметка #черновик]] #настоящий', ['настоящий']],
    ['##не-тег и цвет #fff', ['fff']],
    ['Тег в конце #курс/', ['курс']],
  ];
  rows.forEach(([text, tags]) => {
    it(text, () => expect(parseNote(text).tags).toEqual(tags));
  });
});

describe('заметки: свойства', () => {
  const rows: [name: string, text: string, properties: NoteProperties, body: string][] = [
    ['ключ и значение', '---\nстатус: идёт\nurl: https://example.ru/a\n---\nТекст', {
      статус: 'идёт', url: 'https://example.ru/a',
    }, 'Текст'],
    ['список в скобках', '---\nтеги: [огэ, "a, b", \'it\'\'s\']\nпусто: []\n---\n', {
      теги: ['огэ', 'a, b', 'it\'s'], пусто: [],
    }, ''],
    ['список строками', '---\nтеги:\n  - огэ\n  - "python: основы"\nстатус: пауза\n---\n# План', {
      теги: ['огэ', 'python: основы'], статус: 'пауза',
    }, '# План'],
    ['пустое значение и кавычки', '---\nавтор:\nназвание: "Строка: с двоеточием"\nвремя: 10:30\n---\nА', {
      автор: '', название: 'Строка: с двоеточием', время: '10:30',
    }, 'А'],
    ['ссылка в свойстве — строка', '---\nсвязано: [[Сервер X99]]\n---\n', { связано: '[[Сервер X99]]' }, ''],
    ['переводы строк CRLF', '---\r\nстатус: идёт\r\n---\r\nТекст\r\n', { статус: 'идёт' }, 'Текст\r\n'],
    ['без свойств', 'Просто текст\n---\nне свойства: да\n---', {}, 'Просто текст\n---\nне свойства: да\n---'],
    ['блок без конца', '---\nстатус: идёт\nТекст дальше', {}, '---\nстатус: идёт\nТекст дальше'],
    ['неразобранная строка', '---\nстатус: идёт\nпросто строка\n---\nТекст', {},
      '---\nстатус: идёт\nпросто строка\n---\nТекст'],
    ['пункт без ключа', '---\n- огэ\n---\nТекст', {}, '---\n- огэ\n---\nТекст'],
    ['вложенные свойства', '---\nа:\n  б: 1\n---\nТекст', {}, '---\nа:\n  б: 1\n---\nТекст'],
    ['черта в начале текста', '---\n10:30 встреча\n---\nТекст', {}, '---\n10:30 встреча\n---\nТекст'],
  ];
  rows.forEach(([name, text, properties, body]) => {
    it(name, () => {
      const note = parseNote(text);
      expect(note.properties).toEqual(properties);
      expect(note.body).toBe(body);
    });
  });

  it('ссылки, теги и пункты берутся из текста, номера строк — от начала файла', () => {
    const note = parseNote('---\nстатус: идёт\nтеги: [#нетег]\n---\n# План\n- [ ] Позвонить [[Маме]] #семья');
    expect(note.links).toEqual(['Маме']);
    expect(note.tags).toEqual(['семья']);
    expect(note.tasks).toEqual([{ line: 5, isDone: false, text: 'Позвонить [[Маме]] #семья', marker: undefined }]);
  });
});

describe('заметки: запись свойств', () => {
  const rows: [name: string, properties: NoteProperties, body: string, text?: string][] = [
    ['без свойств', {}, '# План\n- [ ] Пункт\n', '# План\n- [ ] Пункт\n'],
    ['строки и список', { статус: 'идёт', теги: ['огэ', 'курс'] }, 'Текст',
      '---\nстатус: идёт\nтеги: [огэ, курс]\n---\nТекст'],
    ['пустой текст', { статус: 'пауза' }, '', '---\nстатус: пауза\n---\n'],
    ['значения, которым нужны кавычки', {
      пусто: '', пробелы: '  по краям ', скобка: '[не список]', ссылка: '[[Сервер X99]]', решётка: '#тег',
      кавычки: '"в кавычках"', апостроф: '\'так\'', черта: '- пункт', строки: 'первая\nвторая',
      двоеточие: 'время: 10:30', путь: 'C:\\папка',
    }, 'Текст\n'],
    ['списки с трудными значениями', {
      теги: ['a, b', 'c]', '', ' пробел', '"цитата"', 'ё-моё', 'строка\nвторая'], пустой: [], один: ['один'],
    }, '\n\nТекст с пустыми строками в начале'],
    ['текст похож на свойства', { статус: 'идёт' }, '---\nне свойства\n---\n'],
  ];
  rows.forEach(([name, properties, body, text]) => {
    it(name, () => {
      const serialized = serializeNote({ properties, body });
      if (text !== undefined) expect(serialized).toBe(text);
      const note = parseNote(serialized);
      expect(note.properties).toEqual(properties);
      expect(note.body).toBe(body);
    });
  });
});

describe('заметки: пункты', () => {
  const rows: [text: string, tasks: NoteTask[]][] = [
    ['- [ ] Блок питания 1000 Вт', [{ line: 0, isDone: false, text: 'Блок питания 1000 Вт', marker: undefined }]],
    ['- [x] Пересечения в дорожках\n- [X] Большая буква', [
      { line: 0, isDone: true, text: 'Пересечения в дорожках', marker: undefined },
      { line: 1, isDone: true, text: 'Большая буква', marker: undefined },
    ]],
    ['- [ ] сдать отчёт до пт ^t7f3a', [{ line: 0, isDone: false, text: 'сдать отчёт до пт', marker: 't7f3a' }]],
    ['# План\n- Список\n  - [ ] Вложенный ^tabc123  \n    * [x] Глубже\n\t+ [ ] С табом', [
      { line: 2, isDone: false, text: 'Вложенный', marker: 'tabc123' },
      { line: 3, isDone: true, text: 'Глубже', marker: undefined },
      { line: 4, isDone: false, text: 'С табом', marker: undefined },
    ]],
    ['- [ ] ^t0000\n- [ ]\n- [ ] ', [
      { line: 0, isDone: false, text: '', marker: 't0000' },
      { line: 1, isDone: false, text: '', marker: undefined },
      { line: 2, isDone: false, text: '', marker: undefined },
    ]],
    ['- [ ] не метка ^t12\n- [ ] в середине ^tabcd текста\n- [ ] чужая метка ^abcd', [
      { line: 0, isDone: false, text: 'не метка ^t12', marker: undefined },
      { line: 1, isDone: false, text: 'в середине ^tabcd текста', marker: undefined },
      { line: 2, isDone: false, text: 'чужая метка ^abcd', marker: undefined },
    ]],
    ['-[ ] без пробела\n- [] пусто\n- [ ]слитно\n[ ] без черты\n- [y] не галочка', []],
    ['```\n- [ ] в коде\n```\n- [ ] настоящий\r\n- [x] и этот ^tzz99\r', [
      { line: 3, isDone: false, text: 'настоящий', marker: undefined },
      { line: 4, isDone: true, text: 'и этот', marker: 'tzz99' },
    ]],
  ];
  rows.forEach(([text, tasks]) => {
    it(JSON.stringify(text), () => expect(parseNote(text).tasks).toEqual(tasks));
  });
});

describe('заметки: превью', () => {
  const rows: [text: string, preview: string][] = [
    ['', ''],
    ['\n\n# План\nТекст', 'План'],
    ['#\n##\n\nФедеративное **self-hosted** супер-приложение на `Rust`.',
      'Федеративное self-hosted супер-приложение на Rust.'],
    ['---\nстатус: идёт\n---\n\n- [ ] Забрать платы до пт ^t7f3a', 'Забрать платы до пт'],
    ['> См. [[Parvane — календарь|календарь]] и [[Сервер X99]]', 'См. календарь и Сервер X99'],
    ['---\n***\n1. Первый [пункт](https://example.ru) _важно_', 'Первый пункт важно'],
    ['```js\nconst a = 1;\n```\nПосле кода', 'После кода'],
    ['имя_с_подчёркиваниями и 2*3*4', 'имя_с_подчёркиваниями и 2*3*4'],
    ['слово '.repeat(40), `${'слово '.repeat(23)}с…`],
  ];
  rows.forEach(([text, preview]) => {
    it(JSON.stringify(text.slice(0, 40)), () => {
      const result = parseNote(text).preview;
      expect(result).toBe(preview);
      expect(result.length).toBeLessThanOrEqual(140);
    });
  });
});

describe('заметки: галочка', () => {
  const TEXT = '# План\n- [ ] Первый ^taaaa\n  - [x] Второй\r\n- [X] Третий\nТекст';
  const rows: [name: string, line: number, isDone: boolean, expected: string][] = [
    ['поставить', 1, true, '# План\n- [x] Первый ^taaaa\n  - [x] Второй\r\n- [X] Третий\nТекст'],
    ['снять у вложенного', 2, false, '# План\n- [ ] Первый ^taaaa\n  - [ ] Второй\r\n- [X] Третий\nТекст'],
    ['снять большую букву', 3, false, '# План\n- [ ] Первый ^taaaa\n  - [x] Второй\r\n- [ ] Третий\nТекст'],
    ['уже стоит', 2, true, TEXT],
    ['строка не пункт', 0, true, TEXT],
    ['строки нет', 9, true, TEXT],
    ['отрицательный номер', -1, true, TEXT],
  ];
  rows.forEach(([name, line, isDone, expected]) => {
    it(name, () => expect(setTaskDone(TEXT, line, isDone)).toBe(expected));
  });
});

describe('заметки: метки пунктов', () => {
  const TEXT = '# План\n- [ ] сдать отчёт до пт\n- [x] забрать платы ^t7f3a  \n- [ ] позвонить\r\nТекст';

  it('ставит метку пункту без метки', () => {
    expect(ensureTaskMarker(TEXT, 1, makeIds('abcd'))).toEqual({
      text: '# План\n- [ ] сдать отчёт до пт ^tabcd\n- [x] забрать платы ^t7f3a  \n- [ ] позвонить\r\nТекст',
      marker: 'tabcd',
    });
  });

  it('сохраняет перевод строки CRLF', () => {
    expect(ensureTaskMarker(TEXT, 3, makeIds('abcd')).text).toContain('- [ ] позвонить ^tabcd\r\nТекст');
  });

  it('не трогает пункт с меткой и строку без пункта', () => {
    expect(ensureTaskMarker(TEXT, 2, makeIds('abcd'))).toEqual({ text: TEXT, marker: 't7f3a' });
    expect(ensureTaskMarker(TEXT, 0, makeIds('abcd'))).toEqual({ text: TEXT, marker: undefined });
    expect(ensureTaskMarker(TEXT, 40, makeIds('abcd'))).toEqual({ text: TEXT, marker: undefined });
  });

  it('не повторяет метку, уже занятую в заметке', () => {
    expect(ensureTaskMarker(TEXT, 1, makeIds('7f3a', '7f3a', 'bbbb')).marker).toBe('tbbbb');
    const stuck = ensureTaskMarker(TEXT, 1, () => '7f3a').marker!;
    expect(stuck).not.toBe('t7f3a');
    expect(stuck).toMatch(/^t[a-z0-9]{4,12}$/);
  });

  it('метка по умолчанию читается обратно', () => {
    const { text, marker } = ensureTaskMarker('- [ ] пункт', 0);
    expect(marker).toMatch(/^t[a-z0-9]{5}$/);
    expect(parseNote(text).tasks).toEqual([{ line: 0, isDone: false, text: 'пункт', marker }]);
    expect(findTaskLine(text, marker!)).toBe(0);
  });

  const findRows: [marker: string, line: number | undefined][] = [
    ['t7f3a', 2], ['^t7f3a', 2], ['tzzzz', undefined], ['', undefined],
  ];
  findRows.forEach(([marker, line]) => {
    it(`строка метки «${marker}»`, () => expect(findTaskLine(TEXT, marker)).toBe(line));
  });

  it('не ищет метку в коде и в обычном тексте', () => {
    expect(findTaskLine('```\n- [ ] в коде ^tcode1\n```\nтекст ^tcode1', 'tcode1')).toBeUndefined();
  });

  it('удаляет строку пункта', () => {
    expect(removeTaskLine(TEXT, 't7f3a')).toBe('# План\n- [ ] сдать отчёт до пт\n- [ ] позвонить\r\nТекст');
    expect(removeTaskLine('- [ ] один ^tlast1', 'tlast1')).toBe('');
    expect(removeTaskLine('Текст\n- [ ] в конце ^tlast1', 'tlast1')).toBe('Текст');
    expect(removeTaskLine(TEXT, 'tzzzz')).toBe(TEXT);
  });

  it('копия пункта получает новую метку, первая строка сохраняет прежнюю', () => {
    const copied = '- [ ] отчёт ^t7f3a\n- [ ] другой ^tbbbb\n  - [x] отчёт (копия) ^t7f3a\r\n- [ ] отчёт ^t7f3a';
    expect(dedupeTaskMarkers(copied, makeIds('bbbb', 'cccc', 'dddd'))).toEqual({
      text: '- [ ] отчёт ^t7f3a\n- [ ] другой ^tbbbb\n  - [x] отчёт (копия) ^tcccc\r\n- [ ] отчёт ^tdddd',
      changes: [
        { line: 2, oldMarker: 't7f3a', newMarker: 'tcccc' },
        { line: 3, oldMarker: 't7f3a', newMarker: 'tdddd' },
      ],
    });
  });

  it('без повторов текст прежний', () => {
    expect(dedupeTaskMarkers(TEXT)).toEqual({ text: TEXT, changes: [] });
  });
});

describe('заметки: индекс', () => {
  const NOTES: NoteSource[] = [
    {
      id: 'oge', title: 'Курс ОГЭ', folder: 'Проекты', updatedAt: 30,
      text: '---\nстатус: идёт\n---\n# План\n- Шпаргалка — [[python: основы]]\n- [ ] Собрать банк задач #огэ #Курс\n'
        + 'См. [[Банк задач]] и [[курс огэ]]',
    },
    {
      id: 'py', title: 'Python: основы', folder: 'Курсы', updatedAt: 10,
      text: 'Переменные, циклы, списки. Ещё раз про ёлку и счёт.\n#курс',
    },
    {
      id: 'py8', title: 'Python, 8 класс', folder: 'Курсы', updatedAt: 20,
      text: 'Курс «Бассейн».\n- Опора: [[Python: основы|основы]] и [[Python: основы]]\n- [[банк задач]] #огэ',
    },
    { id: 'x99', title: 'Сервер X99', folder: '', updatedAt: 40, text: 'Бюджетный сервер. `[[Курс ОГЭ]]` #железо' },
    { id: 'py-copy', title: ' python: ОСНОВЫ ', folder: 'Архив', updatedAt: 50, text: 'Одноимённая копия' },
  ];
  const index = buildNotesIndex(NOTES);
  const ids = (notes: { id: string }[]) => notes.map(({ id }) => id);

  const titleRows: [title: string, id: string | undefined][] = [
    ['Курс ОГЭ', 'oge'], ['  курс огэ ', 'oge'], ['PYTHON: ОСНОВЫ', 'py'], ['Нет такой', undefined], ['', undefined],
  ];
  titleRows.forEach(([title, id]) => {
    it(`по названию «${title}»`, () => expect(index.byTitle(title)?.id).toBe(id));
  });

  it('по идентификатору', () => {
    expect(index.byId('x99')?.title).toBe('Сервер X99');
    expect(index.byId('нет')).toBeUndefined();
    expect(ids(index.notes)).toEqual(ids(NOTES));
  });

  it('исходящие ссылки и заметки, которых ещё нет', () => {
    expect(index.byId('oge')).toMatchObject({ linkedIds: ['py'], unresolved: ['Банк задач'] });
    expect(index.byId('py8')).toMatchObject({ linkedIds: ['py'], unresolved: ['банк задач'] });
    expect(index.byId('x99')).toMatchObject({ linkedIds: [], unresolved: [] });
    expect(index.unresolved).toEqual([{ title: 'Банк задач', fromIds: ['oge', 'py8'] }]);
  });

  const backlinkRows: [id: string, from: string[]][] = [
    ['py', ['oge', 'py8']], ['oge', []], ['py-copy', []], ['нет', []],
  ];
  backlinkRows.forEach(([id, from]) => {
    it(`обратные ссылки «${id}»`, () => expect(ids(index.backlinks(id))).toEqual(from));
  });

  it('теги со счётчиками', () => {
    expect(index.tags).toEqual([
      { tag: 'курс', count: 2 }, { tag: 'огэ', count: 2 }, { tag: 'железо', count: 1 },
    ]);
  });

  const searchRows: [query: string, found: string[]][] = [
    ['python', ['py-copy', 'py8', 'py', 'oge']],
    ['PYTHON основы', ['py-copy', 'py', 'oge', 'py8']],
    ['елку', ['py']],
    ['ещё СЧЕТ', ['py']],
    ['счёт', ['py']],
    ['сервер', ['x99']],
    ['курс 8', ['py8']],
    ['идёт', ['oge']],
    ['нет-такого-слова', []],
    ['python сервер', []],
    ['   ', ['py-copy', 'x99', 'oge', 'py8', 'py']],
  ];
  searchRows.forEach(([query, found]) => {
    it(`поиск «${query}»`, () => expect(ids(index.search(query))).toEqual(found));
  });

  it('пустой набор', () => {
    const empty = buildNotesIndex([]);
    expect(empty.notes).toEqual([]);
    expect(empty.search('а')).toEqual([]);
    expect(empty.backlinks('а')).toEqual([]);
    expect(empty.tags).toEqual([]);
  });
});

describe('заметки: переименование ссылок', () => {
  const rows: [text: string, oldTitle: string, newTitle: string, expected: string][] = [
    ['См. [[Курс ОГЭ]]', 'Курс ОГЭ', 'ОГЭ 2027', 'См. [[ОГЭ 2027]]'],
    ['[[курс огэ|курс]] и [[ КУРС ОГЭ ]]', ' Курс ОГЭ', 'ОГЭ 2027', '[[ОГЭ 2027|курс]] и [[ОГЭ 2027]]'],
    ['[[Курс ОГЭ|]] [[Курс]] [[Курс ОГЭ 2]]', 'Курс ОГЭ', 'ОГЭ', '[[ОГЭ|]] [[Курс]] [[Курс ОГЭ 2]]'],
    ['`[[Курс ОГЭ]]` и [[Курс ОГЭ]]', 'Курс ОГЭ', 'ОГЭ', '`[[Курс ОГЭ]]` и [[ОГЭ]]'],
    ['```\n[[Курс ОГЭ]]\n```\n[[Курс ОГЭ]]\r\nТекст', 'курс огэ', 'ОГЭ', '```\n[[Курс ОГЭ]]\n```\n[[ОГЭ]]\r\nТекст'],
    ['[[parvane]]', 'Parvane', 'Parvane', '[[Parvane]]'],
    ['Без ссылок на [[Другое]]', 'Курс ОГЭ', 'ОГЭ', 'Без ссылок на [[Другое]]'],
  ];
  rows.forEach(([text, oldTitle, newTitle, expected]) => {
    it(JSON.stringify(text), () => expect(renameLinks(text, oldTitle, newTitle)).toBe(expected));
  });
});

describe('заметки: название и заметка дня', () => {
  it('ключ названия', () => {
    expect(normalizeNoteTitle('  Курс ОГЭ ')).toBe('курс огэ');
  });

  it('заметка дня', () => {
    expect(dailyNoteTitle('2026-10-12')).toBe('2026-10-12');
    const note = parseNote(dailyNoteTemplate('2026-10-12'));
    expect(note.properties).toEqual({});
    expect(note.body.startsWith('# 2026-10-12\n')).toBe(true);
    expect(note.tasks).toEqual([{ line: 2, isDone: false, text: '', marker: undefined }]);
    expect(note.preview).toBe('2026-10-12');
  });
});

describe('заметки: кэш разбора по объекту заметки', () => {
  it('тот же объект с тем же текстом — тот же разбор; новый текст — новый', () => {
    const note = { id: 'a', title: 'А', folder: '', text: '# А\n\n[[Б]] #тег\n', updatedAt: 1 };
    const parsed = parseNoteCached(note);
    expect(parsed.links).toEqual(['Б']);
    expect(parseNoteCached(note)).toBe(parsed);
    expect(parseNoteCached({ ...note })).not.toBe(parsed);
    expect(parseNoteCached({ ...note }).tags).toEqual(['тег']);
    expect(parseNoteCached({ ...note, text: '# А\n\n[[В]]\n' }).links).toEqual(['В']);
  });

  it('строка поиска: без регистра, «ё» = «е», длина сохранена, одна копия на объект', () => {
    const note = { id: 'a', title: 'А', folder: '', text: 'Ёлка İstanbul', updatedAt: 1 };
    const value = noteSearchText(note);
    expect(value.length).toBe(note.text.length);
    expect(value.startsWith('елка ')).toBe(true);
    expect(noteSearchText(note)).toBe(value);
    expect(buildNotesIndex([note]).search('ёЛКА').map(({ id }) => id)).toEqual(['a']);
  });
});
