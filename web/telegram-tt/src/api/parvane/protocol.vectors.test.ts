import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { initSync, runConformanceVectors } from '../../lib/parvane-protocol/parvane_protocol';
import { v2Class, type V2Content, v2ToWire } from './v2/contentMap';

// Протокол v2 (spec 007, T081/T085/T088): векторы proto/parvane/vectors/**
// прогоняются тем же WASM-движком, что работает в клиенте. Логика сверки —
// в движке (`parvane_protocol::conformance`), общая для всех обвязок.
const REPO_ROOT = path.resolve(process.cwd(), '../..');
const VECTORS = path.join(REPO_ROOT, 'proto/parvane/vectors');
const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');

const SUITES: [string, string][] = [
  ['seal/sealed', 'seal/sealed.json'],
  ['seal/group', 'seal/group.json'],
  ['invite/links', 'invite/links.json'],
  ['content/kinds', 'content/kinds.json'],
  ['l2/mode', 'l2/mode.json'],
];

type ContentCase = {
  name: string;
  expect: { content?: V2Content; disposition?: string };
  client?: { class: string; v1?: Record<string, unknown> };
};

describe('векторы протокола v2 через WASM-движок', () => {
  initSync({ module: readFileSync(WASM) });

  it.each(SUITES)('%s', (suite, file) => {
    const cases = runConformanceVectors(suite, readFileSync(path.join(VECTORS, file), 'utf8'));
    expect(cases).toBeGreaterThan(2);
  });

  // T085: перекладка содержимого движка в содержимое UI — та же для всех
  // клиентов (desktop/android сверяют тот же файл через parvane-core)
  describe('content/kinds → содержимое UI', () => {
    const file = JSON.parse(readFileSync(path.join(VECTORS, 'content/kinds.json'), 'utf8')) as { cases: ContentCase[] };
    const cases = file.cases.filter((c) => c.client);

    it('векторы с ожиданием клиента есть', () => {
      expect(cases.length).toBeGreaterThan(30);
    });

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const content = c.expect.content!;
      // движок велел показать заглушку — клиент содержимое не разбирает
      const got = c.expect.disposition === 'stub' ? 'stub' : v2Class(content);
      expect(got).toBe(c.client!.class);
      if (c.client!.class === 'message') {
        expect(v2ToWire(content)).toMatchObject(c.client!.v1!);
      } else if (c.expect.disposition !== 'stub') {
        expect(v2ToWire(content)).toBeUndefined();
      }
    });
  });
});
