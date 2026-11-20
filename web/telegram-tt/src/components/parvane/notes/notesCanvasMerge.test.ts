import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  beforeAll, describe, expect, it,
} from 'vitest';

import { loadProtocol } from '../../../api/parvane/v2/engine';
import { parseCanvas, serializeCanvas } from './notesCanvas';
import { mergeCanvasTexts } from './notesCanvasMerge';

// Общий образец NOTES-3: тот же файл проверяет движок (`tests/notes_canvas_merge_vectors.rs`)
type Sample = {
  cases: { name: string; base: string; mine: string; theirs: string; expect: { doc: unknown; conflicts: number } }[];
};

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../conformance/notes-canvas-merge/cases.json'), 'utf8'),
) as Sample;

beforeAll(async () => {
  await loadProtocol();
});

describe('сведение холста двух устройств (NOTES-3)', () => {
  it.each(SAMPLE.cases)('$name', ({
    base, mine, theirs, expect: wanted,
  }) => {
    const merged = mergeCanvasTexts(base, mine, theirs);
    expect(merged.conflicts).toBe(wanted.conflicts);
    expect(merged.text).toBe(serializeCanvas(parseCanvas(JSON.stringify(wanted.doc)).doc));
  });
});
