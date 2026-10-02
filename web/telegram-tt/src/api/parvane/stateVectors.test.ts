import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { initSync, runConformanceVectors } from '../../lib/parvane-protocol/parvane_protocol';

// Правило STATE-1 (spec 007, T099): сведение личного состояния детерминировано —
// каждый порядок записей из proto/parvane/vectors/state/merge.json даёт тот же
// снимок и тот же набор отвергнутых. Сверка — в движке (набор `state/merge`
// в `parvane_protocol::conformance`), тот же WASM, что работает в клиенте
const REPO_ROOT = path.resolve(process.cwd(), '../..');
const MERGE_VECTORS = path.join(REPO_ROOT, 'proto/parvane/vectors/state/merge.json');
const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');
const MIN_CASES = 8;

describe('STATE-1: векторы сведения личного состояния через WASM-движок', () => {
  initSync({ module: readFileSync(WASM) });

  it('state/merge: любой порядок записей — тот же снимок', () => {
    const cases = runConformanceVectors('state/merge', readFileSync(MERGE_VECTORS, 'utf8'));
    expect(cases).toBeGreaterThanOrEqual(MIN_CASES);
  });

  it('испорченный вектор ловится', () => {
    const vectors = JSON.parse(readFileSync(MERGE_VECTORS, 'utf8')) as {
      cases: { expect: { max_lamport: number } }[];
    };
    vectors.cases[0].expect.max_lamport += 1;
    expect(() => runConformanceVectors('state/merge', JSON.stringify(vectors))).toThrow();
  });
});
