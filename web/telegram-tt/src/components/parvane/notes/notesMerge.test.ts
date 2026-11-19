import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  beforeAll, describe, expect, it,
} from 'vitest';

import type { NotesMergeChoice, NotesMergePart } from './notesMerge';

import { loadProtocol } from '../../../api/parvane/v2/engine';
import { isConflictPart, mergeNotes, resolveNotes } from './notesMerge';

// Общий образец NOTES-2: тот же файл проверяет движок (`tests/notes_merge_vectors.rs`)
type Three = { name: string; base: string; mine: string; theirs: string };
type Sample = {
  merge: (Three & { text: string; conflict: boolean })[];
  resolve: (Three & { choices: NotesMergeChoice[]; text: string })[];
  parts: (Three & { parts: NotesMergePart[]; autoLines: number })[];
};

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../conformance/notes-merge/cases.json'), 'utf8'),
) as Sample;

beforeAll(async () => {
  await loadProtocol();
});

describe('слияние заметки (NOTES-2)', () => {
  SAMPLE.merge.forEach((item) => {
    it(item.name, () => {
      const result = mergeNotes(item.base, item.mine, item.theirs);
      expect({ text: result.text, hasConflict: result.hasConflict }).toEqual({
        text: item.text, hasConflict: item.conflict,
      });
      expect(result.parts.some(isConflictPart)).toBe(item.conflict);
    });
  });

  SAMPLE.resolve.forEach((item) => {
    it(`решение: ${item.name}`, () => {
      expect(resolveNotes(item.base, item.mine, item.theirs, item.choices)).toBe(item.text);
    });
  });

  SAMPLE.parts.forEach((item) => {
    it(`участки: ${item.name}`, () => {
      const result = mergeNotes(item.base, item.mine, item.theirs);
      expect(result.parts).toEqual(item.parts);
      expect(result.autoLines).toBe(item.autoLines);
    });
  });
});
