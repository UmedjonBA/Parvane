import { describe, expect, it } from 'vitest';

import type { GuideNote } from '../../../parvane/notes/notesGuide';

import { buildGuide } from '../../../parvane/notes/notesGuide';
import { searchHelp } from './helpSearch';

const NOTES = [
  { key: 'overview', nodeId: 'a', title: 'Обзор', text: '# Обзор\n- Ёлка в саду\nПросто строка' },
  { key: 'chats', nodeId: 'b', title: 'Чаты', text: 'Сообщения шифруются\n> Звонки тоже' },
] as unknown as GuideNote[];

describe('searchHelp', () => {
  it('returns every note for an empty query', () => {
    expect(searchHelp(NOTES, '  ').map(({ note }) => note.title)).toEqual(['Обзор', 'Чаты']);
  });

  it('matches title without a snippet and text with a clean line', () => {
    expect(searchHelp(NOTES, 'чаты')).toEqual([{ note: NOTES[1], snippet: undefined }]);
    expect(searchHelp(NOTES, 'звонки')).toEqual([{ note: NOTES[1], snippet: 'Звонки тоже' }]);
    expect(searchHelp(NOTES, 'елка')).toEqual([{ note: NOTES[0], snippet: 'Ёлка в саду' }]);
  });

  it('needs every word of the query', () => {
    expect(searchHelp(NOTES, 'звонки ёлка')).toEqual([]);
  });

  it('finds something in the real guide', () => {
    const guide = buildGuide('en');
    const keys = searchHelp(guide.notes, guide.notes[1].title).map(({ note }) => note.key);
    expect(keys).toContain(guide.notes[1].key);
  });
});
