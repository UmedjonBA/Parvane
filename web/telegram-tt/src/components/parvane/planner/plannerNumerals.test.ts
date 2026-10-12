import { describe, expect, it } from 'vitest';

import type { NumeralLang } from './plannerNumerals';

import { restoreNumerals, rewriteNumerals, toSourceOffset } from './plannerNumerals';

type Row = [input: string, rewritten: string];

function run(lang: NumeralLang, rows: Row[]) {
  rows.forEach(([input, rewritten]) => {
    it(input, () => {
      expect(rewriteNumerals(input, lang).text).toBe(rewritten);
    });
  });
}

describe('числительные: русский', () => {
  run('ru', [
    ['в пять', 'в 5'],
    ['в семь вечера', 'в 7 вечера'],
    ['В Семь', 'В 7'],
    ['в десять тридцать', 'в 10:30'],
    ['в двадцать тридцать', 'в 20:30'],
    ['в двадцать один тридцать', 'в 21:30'],
    ['в семь ноль пять', 'в 7:05'],
    ['в девять ноль ноль', 'в 9:00'],
    ['в двадцать пять', 'в 25'],
    ['десять тридцать', '10 30'],
    ['через два дня', 'через 2 дня'],
    ['три раза', '3 раза'],
    ['каждые две недели', 'каждые 2 недели'],
    ['сорок пять минут', '45 минут'],
    ['девяносто девять', '99'],
    ['с десяти до двенадцати', 'с 10 до 12'],
    ['до трёх', 'до 3'],
    ['около трёх', 'около трёх'],
    ['на час', '1 ч'],
    ['на час дня', 'на час дня'],
    ['в час', 'в 1'],
    ['в час дня', 'в 1 дня'],
    ['в час пик', 'в час пик'],
    ['классный час', 'классный час'],
    ['два с половиной часа', '2.5 часа'],
    ['два с половиной литра', '2 с половиной литра'],
    ['полтретьего', '2:30'],
    ['пол третьего', '2:30'],
    ['пол-третьего', '2:30'],
    ['половина третьего', '2:30'],
    ['в половине первого', 'в 12:30'],
    ['полдвенадцатого', '11:30'],
    ['без пятнадцати пять', '4:45'],
    ['без четверти пять', '4:45'],
    ['без четверти час', '12:45'],
    ['без пяти минут шесть', '5:55'],
    ['без двадцати пяти десять', '9:35'],
    ['без пяти минут инженер', 'без пяти минут инженер'],
    ['четверть шестого', '5:15'],
    ['четверть первого', '12:15'],
    ['пять минут шестого', '5:05'],
    ['двадцать минут первого', '12:20'],
    ['пять минут назад', '5 минут назад'],
    // Не числительные
    ['пара', 'пара'],
    ['полчаса', 'полчаса'],
    ['полдень', 'полдень'],
    ['пол', 'пол'],
    ['тридцатый', 'тридцатый'],
    ['v2два', 'v2два'],
    ['', ''],
  ]);
});

describe('numerals: english', () => {
  run('en', [
    ['at five', 'at 5'],
    ['at seven pm', 'at 7 pm'],
    ['At Seven', 'At 7'],
    ['at ten thirty', 'at 10:30'],
    ['at seven oh five', 'at 7:05'],
    ['at twenty-one thirty', 'at 21:30'],
    ['ten thirty', '10 30'],
    ['five o\'clock', '5'],
    ['five o’clock', '5'],
    ['in two days', 'in 2 days'],
    ['three times', '3 times'],
    ['every two weeks', 'every 2 weeks'],
    ['twenty five minutes', '25 minutes'],
    ['twenty-five minutes', '25 minutes'],
    ['half past two', '2:30'],
    ['half past twelve', '12:30'],
    ['quarter to five', '4:45'],
    ['a quarter to five', '4:45'],
    ['quarter to one', '12:45'],
    ['quarter past five', '5:15'],
    ['quarter after five', '5:15'],
    ['ten past five', '5:10'],
    ['ten minutes past five', '5:10'],
    ['ten minutes to five', '4:50'],
    ['ten to five', '10 to 5'],
    ['two and a half hours', '2.5 hours'],
    ['two and a half men', '2 and a half men'],
    ['for an hour', '1 hr'],
    ['for an hour and a half', 'for an hour and a half'],
    // Not numerals
    ['a week', 'a week'],
    ['half an hour', 'half an hour'],
    ['noon', 'noon'],
    ['second', 'second'],
    ['someone', 'someone'],
    ['v2two', 'v2two'],
  ]);
});

describe('числительные: исходные слова', () => {
  it('замены помнят слова и разговорные часы', () => {
    expect(rewriteNumerals('Встреча Полтретьего и в Пять', 'ru')).toEqual({
      text: 'Встреча 2:30 и в 5',
      edits: [
        {
          from: 8, to: 12, value: '2:30', source: 'Полтретьего', isLoose: true,
        },
        {
          from: 17, to: 18, value: '5', source: 'Пять', isLoose: undefined,
        },
      ],
    });
  });

  it('строка без числительных не меняется', () => {
    const text = 'купить молоко завтра';
    expect(rewriteNumerals(text, 'ru')).toEqual({ text, edits: [] });
    expect(restoreNumerals(text, [])).toBe(text);
  });

  it('нетронутая замена возвращает слова, забранная — пробелы', () => {
    const { text, edits } = rewriteNumerals('купить пять яблок в семь вечера', 'ru');
    expect(text).toBe('купить 5 яблок в 7 вечера');
    expect(restoreNumerals(text, edits)).toBe('купить пять яблок в семь вечера');
    // «в 7 вечера» распознано: на его месте пробелы
    const marked = `${text.slice(0, 15)}${' '.repeat(text.length - 15)}`;
    expect(restoreNumerals(marked, edits)).toBe(`купить пять яблок ${' '.repeat('в семь вечера'.length)}`);
  });

  it('позиции переписанной строки переводятся в исходные', () => {
    const source = 'в десять тридцать завтра';
    const { text, edits } = rewriteNumerals(source, 'ru');
    expect(text).toBe('в 10:30 завтра');
    const from = text.indexOf('завтра');
    expect(source.slice(toSourceOffset(from, edits), toSourceOffset(text.length, edits, true))).toBe('завтра');
    expect(source.slice(toSourceOffset(0, edits), toSourceOffset(7, edits, true))).toBe('в десять тридцать');
    // Позиция внутри замены — её край
    expect(toSourceOffset(4, edits)).toBe(2);
    expect(toSourceOffset(4, edits, true)).toBe('в десять тридцать'.length);
  });
});
