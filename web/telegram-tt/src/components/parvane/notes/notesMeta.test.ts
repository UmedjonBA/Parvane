import { describe, expect, it } from 'vitest';

import {
  applyNotesMetaChange, EMPTY_NOTES_META, parseNotesMeta, serializeNotesMeta, sortPinnedFirst, tonesByTopPath,
} from './notesMeta';

describe('цвета папок и закреплённые заметки', () => {
  it('файл читается туда и обратно; негодное отбрасывается', () => {
    const meta = applyNotesMetaChange(
      applyNotesMetaChange(EMPTY_NOTES_META, { kind: 'tone', folder: 'f1', tone: 'blue' }),
      { kind: 'pin', note: 'n1', isPinned: true },
    );
    expect(parseNotesMeta(serializeNotesMeta(meta))).toEqual({ tones: { f1: 'blue' }, pinned: ['n1'] });
    expect(parseNotesMeta('{"tones":{"f":"pink","g":"red"},"pinned":["a","a",3]}'))
      .toEqual({ tones: { g: 'red' }, pinned: ['a'] });
    expect(parseNotesMeta('не json')).toEqual(EMPTY_NOTES_META);
  });

  it('заплатка поверх чужой версии сохраняет чужие правки', () => {
    const theirs = parseNotesMeta('{"tones":{"f2":"green"},"pinned":["n2"]}');
    const next = applyNotesMetaChange(theirs, { kind: 'pin', note: 'n1', isPinned: true });
    expect(next).toEqual({ tones: { f2: 'green' }, pinned: ['n1', 'n2'] });
    expect(applyNotesMetaChange(next, { kind: 'tone', folder: 'f2' }).tones).toEqual({});
    expect(applyNotesMetaChange(next, { kind: 'pin', note: 'n2', isPinned: false }).pinned).toEqual(['n1']);
  });

  it('закреплённые — первыми в порядке закрепления', () => {
    const notes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(sortPinnedFirst(notes, ['c', 'b']).map(({ id }) => id)).toEqual(['c', 'b', 'a']);
    expect(sortPinnedFirst(notes, [])).toBe(notes);
  });

  it('цвет — у верхних папок по пути', () => {
    const meta = { tones: { f1: 'red' as const, f2: 'blue' as const }, pinned: [] };
    const tones = tonesByTopPath(meta, [{ id: 'f1', path: 'Сеть' }, { id: 'f2', path: 'Сеть/VPN' }]);
    expect([...tones]).toEqual([['Сеть', 'red']]);
  });
});
