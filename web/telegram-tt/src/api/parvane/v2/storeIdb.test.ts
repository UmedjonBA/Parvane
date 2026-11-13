// spec 035 T016: адаптер хранилища движка web — IndexedDB `parvane-store-v3` (contracts/storage.md).
// Общий набор `proto/parvane/vectors/storage/adapter.json` (тот же, что у ядра desktop/android — ctest
// store_fs_tests): пачки — одна транзакция (сначала удаления, затем записи), чтения по ключам и префиксу,
// прерванная пачка (транзакция отменена на любом шаге) не оставляет следов, перезапуск.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StoreBatch, StorePut } from './gen/model';

import { openStoreIdb } from './storeIdb';

type Step = {
  op: string;
  puts?: { key: string; value_hex: string }[];
  deletes?: string[];
  keys?: string[];
  prefix?: string;
  after?: string;
  limit?: number;
  expect?: { key: string; value_hex: string }[];
  entries?: { key: string; value_hex: string }[];
  options?: { key: string; value_hex: string }[][];
};

const VECTORS = JSON.parse(readFileSync(
  path.resolve(process.cwd(), '../../proto/parvane/vectors/storage/adapter.json'), 'utf8',
)) as { cases: { name: string; steps: Step[] }[] };

function unhex(h: string) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex(b: Uint8Array) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function batchOf(s: Step): StoreBatch {
  return {
    batchId: '0',
    puts: (s.puts ?? []).map((p) => ({ key: p.key, value: unhex(p.value_hex) })),
    deletes: s.deletes ?? [],
  };
}

function plain(rows: StorePut[]) {
  return rows.map((r) => ({ key: r.key, value_hex: hex(r.value) }));
}

let dbSeq = 0;

async function runCase(c: { name: string; steps: Step[] }, abortAfter?: number): Promise<boolean> {
  const name = `parvane-store-v3-test-${dbSeq++}`;
  let st = await openStoreIdb(name);
  let reached = true;
  for (const s of c.steps) {
    if (s.op === 'batch') {
      await st.commit(batchOf(s));
    } else if (s.op === 'batch_interrupted') {
      let failed = false;
      try {
        await st.commit(batchOf(s), { abortAfter });
      } catch {
        failed = true;
      }
      if (!failed) {
        reached = false;
        break;
      }
    } else if (s.op === 'reopen') {
      st.close();
      st = await openStoreIdb(name);
    } else if (s.op === 'pack') {
      // У IndexedDB упаковки нет.
    } else if (s.op === 'read') {
      const rows = await st.read({
        readId: '0', keys: s.keys ?? [], prefix: s.prefix ?? '', after: s.after ?? '', limit: s.limit ?? 0,
      });
      expect(plain(rows), `${c.name}: read ${s.prefix}|${s.after}`).toEqual(s.expect);
    } else if (s.op === 'expect_one_of') {
      const got = plain(await st.readAll());
      expect(s.options!.some((o) => JSON.stringify(o) === JSON.stringify(got)), `${c.name}: пачка атомарна`).toBe(true);
    } else if (s.op === 'expect_all') {
      expect(plain(await st.readAll()), `${c.name}: expect_all`).toEqual(s.entries);
    }
  }
  st.close();
  return reached;
}

describe('storeIdb — общий набор адаптера хранилища (adapter.json)', () => {
  for (const c of VECTORS.cases) {
    const interrupted = c.steps.some((s) => s.op === 'batch_interrupted');
    it(c.name, async () => {
      if (!interrupted) {
        await runCase(c);
        return;
      }
      // Транзакция отменяется после k-го шага (удаление/запись) прерванной пачки — все k.
      let points = 0;
      for (let k = 0; k < 50; k++) {
        if (!await runCase(c, k)) break;
        points++;
      }
      expect(points).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('storeIdb — граница движка', () => {
  it('пачка и чтение в proto3-JSON движка (value — base64)', async () => {
    const st = await openStoreIdb(`parvane-store-v3-test-${dbSeq++}`);
    await st.commitJson(JSON.stringify({
      batch_id: '7', puts: [{ key: 'g1/state-object/A', value: 'qrs=' }, { key: 'root', value: 'CAE=' }],
    }));
    const loaded = JSON.parse(await st.readJson(JSON.stringify({ read_id: '9', prefix: 'g1/' }))) as {
      read_id: string; entries: { key: string; value: string }[];
    };
    expect(loaded).toEqual({ read_id: '9', entries: [{ key: 'g1/state-object/A', value: 'qrs=' }] });
    st.close();
  });

  it('база — отдельная parvane-store-v3', async () => {
    const st = await openStoreIdb();
    expect(st.name).toBe('parvane-store-v3');
    st.close();
  });
});
