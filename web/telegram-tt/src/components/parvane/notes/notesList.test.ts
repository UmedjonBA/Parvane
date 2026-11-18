import { describe, expect, it } from 'vitest';

import type { LangFn } from '../../../util/localization';

import {
  countDaysAgo, countNoteLinks, firstTagOf, formatNoteEdited, formatNoteTime, sortByRecent,
} from './notesList';
import { buildNotesIndex } from './notesModel';

const WORDS: Record<string, string> = { WeekdayYesterday: 'Yesterday', Today: 'today' };
const lang = Object.assign((key: string) => WORDS[key] || key, { code: 'en-GB' }) as unknown as LangFn;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(18, 15);

describe('заметки: время правки в списке', () => {
  it('сегодня — время, вчера — словом, на этой неделе — день недели, раньше — дата', () => {
    expect(formatNoteTime(lang, at(18, 13, 10), NOW)).toBe('13:10');
    expect(formatNoteTime(lang, at(17, 23, 50), NOW)).toBe('yesterday');
    expect(formatNoteTime(lang, at(16, 9), NOW)).toBe('Mon');
    expect(formatNoteTime(lang, at(9, 9), NOW)).toBe('9 Nov');
    expect(formatNoteTime(lang, new Date(2025, 11, 30, 9).getTime(), NOW)).toBe('30 Dec 2025');
  });

  it('дни считаются по календарю, а не по суткам', () => {
    expect(countDaysAgo(at(17, 23, 59), at(18, 0, 1))).toBe(1);
    expect(countDaysAgo(at(18, 0, 1), at(18, 23, 59))).toBe(0);
  });

  it('под названием заметки — день и время', () => {
    expect(formatNoteEdited(lang, at(18, 13, 10), NOW)).toBe('today, 13:10');
    expect(formatNoteEdited(lang, at(17, 9, 5), NOW)).toBe('yesterday, 09:05');
    expect(formatNoteEdited(lang, at(9, 18, 40), NOW)).toBe('9 Nov, 18:40');
  });
});

describe('заметки: строка списка', () => {
  const notes = [
    {
      id: 'a',
      title: 'Настройка туннеля',
      folder: 'Сеть',
      text: 'Узел — в [[Сервер]], правила — в [[Экран]] #сеть #vpn',
      updatedAt: 30,
    },
    {
      id: 'b',
      title: 'Сервер',
      folder: 'Сервер',
      text: 'См. [[Настройка туннеля]] и [[Ещё не написано]]',
      updatedAt: 50,
    },
    {
      id: 'c', title: 'Экран', folder: '', text: 'Без ссылок', updatedAt: 50,
    },
  ];

  it('недавние сверху, при равном времени — по названию', () => {
    expect(sortByRecent(notes).map(({ id }) => id)).toEqual(['b', 'c', 'a']);
    expect(notes.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('связи: исходящие, входящие и ссылки на ещё не созданные заметки, без повторов', () => {
    const index = buildNotesIndex(notes);
    expect(countNoteLinks(index, 'a')).toBe(2);
    expect(countNoteLinks(index, 'b')).toBe(2);
    expect(countNoteLinks(index, 'c')).toBe(1);
    expect(countNoteLinks(index, 'нет такой')).toBe(0);
  });

  it('первый тег заметки', () => {
    expect(firstTagOf(notes[0])).toBe('сеть');
    expect(firstTagOf(notes[2])).toBeUndefined();
  });
});
