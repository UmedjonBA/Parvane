import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ModelJson, ModelRequest } from './v2/engine';

import { initSync, PvEngine } from '../../lib/parvane-protocol/parvane_protocol';
import { MemoryModelStore, ModelError, ModelHost } from './v2/engine';

// spec 035 T106 (contracts/engine-api.md «Векторы»): векторы модели движка `proto/parvane/vectors/model/*.json`
// через WASM `PvEngine` и хост модели web (`v2/engine.ts` `ModelHost`: пачка фиксируется до запросов, затем
// `storeCommitted`, чтения — `storeLoaded`). Те же правила сверки, что у эталона `backend/protocol/tests/
// model_vectors.rs`: ожидаемое — подмножество фактического, `null` — поле отсутствует, `"$имя"` — переменная.
const REPO_ROOT = path.resolve(process.cwd(), '../..');
const VECTORS = path.join(REPO_ROOT, 'proto/parvane/vectors/model');
const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');
const SUITES = [
  'send_direct', 'delete_everyone_direct', 'delete_me', 'edit_before_row', 'state_patch_folder', 'group_perms_media',
  'unknown_content_stub', 'features_text_fallback', 'history_paging', 'fave_sticker',
];
const MIN_CASES = 13;
const DEVICE_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

type Json = unknown;
type Step = Record<string, Json> & { expect: Record<string, Json> };
type Case = { name: string; config: ModelJson; steps: Step[] };

function absent(v: Json) {
  if (v === null || v === undefined || v === false || v === '' || v === '0' || v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === 'object' && Object.keys(v).length === 0;
}

function matches(exp: Json, act: Json, vars: Map<string, string>, at: string): void {
  if (exp === null) {
    if (!absent(act)) throw new Error(`${at}: ожидалось отсутствие, есть ${JSON.stringify(act)}`);
    return;
  }
  if (typeof exp === 'string' && exp.startsWith('$')) {
    const seen = vars.get(exp);
    const now = JSON.stringify(act);
    if (seen === undefined) vars.set(exp, now);
    else if (seen !== now) throw new Error(`${at}: ${exp} = ${seen}, а здесь ${now}`);
    return;
  }
  if (Array.isArray(exp)) {
    const a = Array.isArray(act) ? act : [];
    if (a.length !== exp.length) throw new Error(`${at}: длина ${a.length} вместо ${exp.length} — ${JSON.stringify(act)}`);
    exp.forEach((x, i) => matches(x, a[i], vars, `${at}[${i}]`));
    return;
  }
  if (typeof exp === 'object') {
    const obj = (act && typeof act === 'object' ? act : {}) as Record<string, Json>;
    Object.entries(exp as Record<string, Json>).forEach(([k, v]) => matches(v, obj[k] ?? null, vars, `${at}.${k}`));
    return;
  }
  if (typeof exp === 'number') {
    if (Number(act) !== exp) throw new Error(`${at}: ${JSON.stringify(act)} вместо ${exp}`);
    return;
  }
  if (exp !== act) throw new Error(`${at}: ${JSON.stringify(act)} вместо ${JSON.stringify(exp)}`);
}

async function runCase(suite: string, c: Case) {
  const at0 = `${suite} / ${c.name}`;
  const store = new MemoryModelStore();
  const deltas: ModelJson[] = [];
  const sent: ModelRequest[] = [];
  const config = { ...c.config, vectors: true, device_key: (c.config.device_key as string) ?? DEVICE_KEY };
  const { host } = await ModelHost.open(config, {
    store,
    send: (r) => sent.push(r),
    onDelta: (d) => deltas.push(d),
  }, (cfg) => PvEngine.open(cfg));
  let revision = deltas.length ? Number(deltas[deltas.length - 1].revision) : 0;
  const vars = new Map<string, string>();
  for (const [i, step] of c.steps.entries()) {
    const at = `${at0} шаг ${i}`;
    const exp = step.expect;
    const [name, args] = Object.entries(step).find(([k]) => k !== 'expect')!;
    const callName = name === 'input' ? 'vectorInput' : name;
    deltas.length = 0;
    sent.length = 0;
    const putsBefore = store.log.length;
    const kinds = new Set<string>();
    const commit = store.commit.bind(store);
    store.commit = (batch) => {
      batch.puts.forEach((p) => kinds.add(p.key.split('/')[1] ?? p.key));
      return commit(batch);
    };
    let out: ModelJson | undefined;
    let error: string | undefined;
    try {
      out = exp.result !== undefined ? host.peek(callName, args) : await host.run(callName, args);
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      error = e.kind;
    } finally {
      store.commit = commit;
    }
    if (typeof exp.error === 'string') {
      expect(error, `${at}: ожидалась ошибка`).toBe(exp.error);
      continue;
    }
    expect(error, `${at}: ошибка`).toBeUndefined();
    if (exp.result !== undefined) {
      matches(exp.result, out, vars, `${at} result`);
      continue;
    }
    for (const d of deltas) {
      expect(Number(d.revision), `${at}: ревизия растёт на 1`).toBe(revision + 1);
      revision = Number(d.revision);
    }
    if (exp.changes !== undefined) {
      const changes = deltas.flatMap((d) => (d.changes as Json[] | undefined) ?? []);
      matches(exp.changes, changes, vars, `${at} changes`);
    }
    if (exp.requests !== undefined) {
      expect(sent.map((r) => r.method), `${at}: запросы`).toEqual(exp.requests);
    }
    if (Array.isArray(exp.puts)) {
      expect(store.log.length, `${at}: пачка`).toBeGreaterThan(putsBefore);
      (exp.puts as string[]).forEach((k) => expect([...kinds], `${at}: в пачке нет ${k}`).toContain(k));
    }
  }
  host.close();
}

describe('ENGINE-1 / T106: векторы модели движка через WASM и хост web', () => {
  initSync({ module: readFileSync(WASM) });

  it('model/*: все наборы проходят через ModelHost', async () => {
    let n = 0;
    for (const s of SUITES) {
      const v = JSON.parse(readFileSync(path.join(VECTORS, `${s}.json`), 'utf8')) as { suite: string; cases: Case[] };
      expect(v.suite).toBe(`model/${s}`);
      for (const c of v.cases) {
        await runCase(s, c);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(MIN_CASES);
  });

  it('испорченный вектор ловится', async () => {
    const v = JSON.parse(readFileSync(path.join(VECTORS, 'state_patch_folder.json'), 'utf8')) as { cases: Case[] };
    const c = v.cases[0];
    (c.steps[0].expect as { requests: string[] }).requests = ['state.append'];
    await expect(runCase('state_patch_folder', c)).rejects.toThrow();
  });

  it('пачка фиксируется раньше, чем уходят запросы того же итога', async () => {
    const order: string[] = [];
    const store = new MemoryModelStore();
    const commit = store.commit.bind(store);
    store.commit = (b) => {
      order.push('commit');
      return commit(b);
    };
    const { host } = await ModelHost.open({
      user: 'alice@local', device_id: 'd1', domain: 'local', now_ms: '1800000000000', vectors: true, device_key: DEVICE_KEY,
    }, { store, send: (r) => order.push(`req:${r.method}`) }, (cfg) => PvEngine.open(cfg));
    order.length = 0;
    await host.submit({ state_create: { object: { kind: 'OBJECT_KIND_FOLDER', key: '7' }, set: [] } });
    expect(order[0]).toBe('commit');
    expect(order).toContain('req:state.ops.append');
    host.close();
  });
});
