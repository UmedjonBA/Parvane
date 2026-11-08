import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { HRowState, HView } from './v2/historyModel';

import {
  auditJsonl, buildAuditDump, canonicalJson, elementKey, statePeerKey,
} from './auditDump';

// Выгрузка «ничего не потеряно» (spec 035, T007). Общий вход и ожидаемые строки — `conformance/audit/`: то же
// гоняет ядро desktop/android (`desktop/parvane-core/tests/audit_dump_tests.cpp`), строки обязаны совпасть побайтно.
// Данные выдуманные

const VECTORS_DIR = join(__dirname, '../../../../../conformance/audit');

type Fixture = {
  rows: (HRowState & { view: HView })[];
  marks: { chat: HRowState['chat']; chatKey: string; up_to_ts_ms: number; up_to_id: string }[];
  ownJournal: never[];
  stateSnapshot: string;
  plannerState: string;
  cloud: { container: { id: string }; state?: string }[];
  groups: { hex: string; info: unknown }[];
  deviceLogs: { user: string; version: number; devices: unknown }[];
  accountKeys: Record<string, boolean>;
};

function loadFixture() {
  return JSON.parse(readFileSync(join(VECTORS_DIR, 'dump-input.json'), 'utf8')) as Fixture;
}

async function dumpFixture(fixture: Fixture) {
  const views = new Map(fixture.rows.map((row) => [row.target, row.view]));
  const markKeys = new Map(fixture.marks.map((mark) => [canonicalJson(mark.chat), mark.chatKey]));
  const lines = await buildAuditDump({
    ...fixture,
    view: (state) => views.get(state.target)!,
    chatKey: (peer) => markKeys.get(canonicalJson(peer)) || '',
  });
  return auditJsonl(lines);
}

describe('auditDump', () => {
  it('canonical JSON sorts keys, drops null fields and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: undefined, c: 'х' }], e: JSON.parse('null') }))
      .toBe('{"a":[3,{"c":"х"}],"b":1}');
    expect(canonicalJson(JSON.parse('{"x":1.0}'))).toBe('{"x":1}');
  });

  it('keys list elements by peer, ref, id fields and digest', async () => {
    expect(statePeerKey({ user: { address: 'bob@local' } })).toBe('u:bob@local');
    expect(await elementKey({ peer: { group: { id: 'AQ==' } } })).toBe('g:AQ==');
    expect(await elementKey({ ref: { id: 'Ag==' } })).toBe('r:Ag==');
    expect(await elementKey({ id: 5 })).toBe('5');
    expect(await elementKey({ text: 'без id' })).toMatch(/^h:[0-9a-f]{16}$/);
  });

  it('matches the shared vectors line for line', async () => {
    const jsonl = await dumpFixture(loadFixture());
    const expectedPath = join(VECTORS_DIR, 'dump-expected.jsonl');
    if (process.env.PARVANE_AUDIT_WRITE_EXPECTED === '1') writeFileSync(expectedPath, jsonl);
    expect(jsonl).toBe(readFileSync(expectedPath, 'utf8'));
    const kinds = new Set(jsonl.trim().split('\n').map((line) => (JSON.parse(line) as { kind: string }).kind));
    ['chat', 'message', 'read-mark', 'outbox', 'draft', 'scheduled', 'sticker-pack', 'saved-gif', 'state:folders',
      'state:contacts', 'planner:tasks', 'cloud:container', 'cloud:folder', 'note', 'group', 'device-log-head',
      'key-material'].forEach((kind) => expect(kinds).toContain(kind));
  });

  it('a changed visible value changes only its own line', async () => {
    const fixture = loadFixture();
    const before = (await dumpFixture(fixture)).split('\n');
    fixture.rows[0].view = { ...fixture.rows[0].view, pinned: false };
    const after = (await dumpFixture(fixture)).split('\n');
    const changed = before.filter((line, index) => line !== after[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('"kind":"message","key":"u:bob@local/01923a4b-5c6d-7001-8000-000000000001"');
  });
});
