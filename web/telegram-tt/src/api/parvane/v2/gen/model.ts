// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
// Граница движка — proto3-JSON (имена полей схемы; int64 — строка, bytes — base64, enum — имя).
/* eslint-disable */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < b.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < b.length ? B64[n & 63] : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

function pick(j: Record<string, unknown>, proto: string, camel: string): unknown {
  return j[proto] !== undefined ? j[proto] : j[camel];
}

export interface DeviceWrap {
  wrappedDek: Uint8Array;
}

export function deviceWrapFromJson(v: unknown): DeviceWrap {
  const j = (v ?? {}) as Record<string, unknown>;
  const wrappedDek = pick(j, 'wrapped_dek', 'wrappedDek');
  const out: DeviceWrap = {
    wrappedDek: wrappedDek === undefined || wrappedDek === null ? new Uint8Array(0) : fromBase64(String(wrappedDek)),
  };
  return out;
}

export function deviceWrapToJson(m: DeviceWrap): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.wrappedDek.length === 0)) j.wrapped_dek = toBase64(m.wrappedDek);
  return j;
}

export interface KindFormat {
  kind: string;
  format: number;
}

export function kindFormatFromJson(v: unknown): KindFormat {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const format = pick(j, 'format', 'format');
  const out: KindFormat = {
    kind: kind === undefined || kind === null ? '' : String(kind),
    format: format === undefined || format === null ? 0 : Number(format),
  };
  return out;
}

export function kindFormatToJson(m: KindFormat): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.format === 0)) j.format = m.format;
  return j;
}

export interface MigrationProgress {
  fromGeneration: number;
  toGeneration: number;
  point: number;
  errors: string[];
}

export function migrationProgressFromJson(v: unknown): MigrationProgress {
  const j = (v ?? {}) as Record<string, unknown>;
  const fromGeneration = pick(j, 'from_generation', 'fromGeneration');
  const toGeneration = pick(j, 'to_generation', 'toGeneration');
  const point = pick(j, 'point', 'point');
  const errors = pick(j, 'errors', 'errors');
  const out: MigrationProgress = {
    fromGeneration: fromGeneration === undefined || fromGeneration === null ? 0 : Number(fromGeneration),
    toGeneration: toGeneration === undefined || toGeneration === null ? 0 : Number(toGeneration),
    point: point === undefined || point === null ? 0 : Number(point),
    errors: Array.isArray(errors) ? errors.map((x) => String(x)) : [],
  };
  return out;
}

export function migrationProgressToJson(m: MigrationProgress): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.fromGeneration === 0)) j.from_generation = m.fromGeneration;
  if (!(m.toGeneration === 0)) j.to_generation = m.toGeneration;
  if (!(m.point === 0)) j.point = m.point;
  if (m.errors.length) j.errors = m.errors.map((x) => x);
  return j;
}

export interface PinWrap {
  salt: Uint8Array;
  iterations: number;
  wrappedDek: Uint8Array;
  check: Uint8Array;
}

export function pinWrapFromJson(v: unknown): PinWrap {
  const j = (v ?? {}) as Record<string, unknown>;
  const salt = pick(j, 'salt', 'salt');
  const iterations = pick(j, 'iterations', 'iterations');
  const wrappedDek = pick(j, 'wrapped_dek', 'wrappedDek');
  const check = pick(j, 'check', 'check');
  const out: PinWrap = {
    salt: salt === undefined || salt === null ? new Uint8Array(0) : fromBase64(String(salt)),
    iterations: iterations === undefined || iterations === null ? 0 : Number(iterations),
    wrappedDek: wrappedDek === undefined || wrappedDek === null ? new Uint8Array(0) : fromBase64(String(wrappedDek)),
    check: check === undefined || check === null ? new Uint8Array(0) : fromBase64(String(check)),
  };
  return out;
}

export function pinWrapToJson(m: PinWrap): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.salt.length === 0)) j.salt = toBase64(m.salt);
  if (!(m.iterations === 0)) j.iterations = m.iterations;
  if (!(m.wrappedDek.length === 0)) j.wrapped_dek = toBase64(m.wrappedDek);
  if (!(m.check.length === 0)) j.check = toBase64(m.check);
  return j;
}

export interface Root {
  storeId: Uint8Array;
  activeGeneration: number;
  pendingGeneration: number;
  wraps: Wrap[];
  kindsMaxFormat: KindFormat[];
  retiringGeneration: number;
}

export function rootFromJson(v: unknown): Root {
  const j = (v ?? {}) as Record<string, unknown>;
  const storeId = pick(j, 'store_id', 'storeId');
  const activeGeneration = pick(j, 'active_generation', 'activeGeneration');
  const pendingGeneration = pick(j, 'pending_generation', 'pendingGeneration');
  const wraps = pick(j, 'wraps', 'wraps');
  const kindsMaxFormat = pick(j, 'kinds_max_format', 'kindsMaxFormat');
  const retiringGeneration = pick(j, 'retiring_generation', 'retiringGeneration');
  const out: Root = {
    storeId: storeId === undefined || storeId === null ? new Uint8Array(0) : fromBase64(String(storeId)),
    activeGeneration: activeGeneration === undefined || activeGeneration === null ? 0 : Number(activeGeneration),
    pendingGeneration: pendingGeneration === undefined || pendingGeneration === null ? 0 : Number(pendingGeneration),
    wraps: Array.isArray(wraps) ? wraps.map((x) => wrapFromJson(x)) : [],
    kindsMaxFormat: Array.isArray(kindsMaxFormat) ? kindsMaxFormat.map((x) => kindFormatFromJson(x)) : [],
    retiringGeneration: retiringGeneration === undefined || retiringGeneration === null ? 0 : Number(retiringGeneration),
  };
  return out;
}

export function rootToJson(m: Root): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.storeId.length === 0)) j.store_id = toBase64(m.storeId);
  if (!(m.activeGeneration === 0)) j.active_generation = m.activeGeneration;
  if (!(m.pendingGeneration === 0)) j.pending_generation = m.pendingGeneration;
  if (m.wraps.length) j.wraps = m.wraps.map((x) => wrapToJson(x));
  if (m.kindsMaxFormat.length) j.kinds_max_format = m.kindsMaxFormat.map((x) => kindFormatToJson(x));
  if (!(m.retiringGeneration === 0)) j.retiring_generation = m.retiringGeneration;
  return j;
}

export interface StoreBatch {
  batchId: string;
  puts: StorePut[];
  deletes: string[];
}

export function storeBatchFromJson(v: unknown): StoreBatch {
  const j = (v ?? {}) as Record<string, unknown>;
  const batchId = pick(j, 'batch_id', 'batchId');
  const puts = pick(j, 'puts', 'puts');
  const deletes = pick(j, 'deletes', 'deletes');
  const out: StoreBatch = {
    batchId: batchId === undefined || batchId === null ? '' : String(batchId),
    puts: Array.isArray(puts) ? puts.map((x) => storePutFromJson(x)) : [],
    deletes: Array.isArray(deletes) ? deletes.map((x) => String(x)) : [],
  };
  return out;
}

export function storeBatchToJson(m: StoreBatch): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.batchId === '' || m.batchId === '0'))) j.batch_id = m.batchId;
  if (m.puts.length) j.puts = m.puts.map((x) => storePutToJson(x));
  if (m.deletes.length) j.deletes = m.deletes.map((x) => x);
  return j;
}

export interface StoreLoaded {
  readId: string;
  entries: StorePut[];
}

export function storeLoadedFromJson(v: unknown): StoreLoaded {
  const j = (v ?? {}) as Record<string, unknown>;
  const readId = pick(j, 'read_id', 'readId');
  const entries = pick(j, 'entries', 'entries');
  const out: StoreLoaded = {
    readId: readId === undefined || readId === null ? '' : String(readId),
    entries: Array.isArray(entries) ? entries.map((x) => storePutFromJson(x)) : [],
  };
  return out;
}

export function storeLoadedToJson(m: StoreLoaded): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.readId === '' || m.readId === '0'))) j.read_id = m.readId;
  if (m.entries.length) j.entries = m.entries.map((x) => storePutToJson(x));
  return j;
}

export interface StorePut {
  key: string;
  value: Uint8Array;
}

export function storePutFromJson(v: unknown): StorePut {
  const j = (v ?? {}) as Record<string, unknown>;
  const key = pick(j, 'key', 'key');
  const value = pick(j, 'value', 'value');
  const out: StorePut = {
    key: key === undefined || key === null ? '' : String(key),
    value: value === undefined || value === null ? new Uint8Array(0) : fromBase64(String(value)),
  };
  return out;
}

export function storePutToJson(m: StorePut): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.key === '')) j.key = m.key;
  if (!(m.value.length === 0)) j.value = toBase64(m.value);
  return j;
}

export interface StoreReads {
  readId: string;
  keys: string[];
  prefix: string;
  after: string;
  limit: number;
}

export function storeReadsFromJson(v: unknown): StoreReads {
  const j = (v ?? {}) as Record<string, unknown>;
  const readId = pick(j, 'read_id', 'readId');
  const keys = pick(j, 'keys', 'keys');
  const prefix = pick(j, 'prefix', 'prefix');
  const after = pick(j, 'after', 'after');
  const limit = pick(j, 'limit', 'limit');
  const out: StoreReads = {
    readId: readId === undefined || readId === null ? '' : String(readId),
    keys: Array.isArray(keys) ? keys.map((x) => String(x)) : [],
    prefix: prefix === undefined || prefix === null ? '' : String(prefix),
    after: after === undefined || after === null ? '' : String(after),
    limit: limit === undefined || limit === null ? 0 : Number(limit),
  };
  return out;
}

export function storeReadsToJson(m: StoreReads): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.readId === '' || m.readId === '0'))) j.read_id = m.readId;
  if (m.keys.length) j.keys = m.keys.map((x) => x);
  if (!(m.prefix === '')) j.prefix = m.prefix;
  if (!(m.after === '')) j.after = m.after;
  if (!(m.limit === 0)) j.limit = m.limit;
  return j;
}

export interface Stored {
  format: number;
  kind: string;
  generation: number;
  payload: Uint8Array;
}

export function storedFromJson(v: unknown): Stored {
  const j = (v ?? {}) as Record<string, unknown>;
  const format = pick(j, 'format', 'format');
  const kind = pick(j, 'kind', 'kind');
  const generation = pick(j, 'generation', 'generation');
  const payload = pick(j, 'payload', 'payload');
  const out: Stored = {
    format: format === undefined || format === null ? 0 : Number(format),
    kind: kind === undefined || kind === null ? '' : String(kind),
    generation: generation === undefined || generation === null ? 0 : Number(generation),
    payload: payload === undefined || payload === null ? new Uint8Array(0) : fromBase64(String(payload)),
  };
  return out;
}

export function storedToJson(m: Stored): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.format === 0)) j.format = m.format;
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.generation === 0)) j.generation = m.generation;
  if (!(m.payload.length === 0)) j.payload = toBase64(m.payload);
  return j;
}

export interface Wrap {
  generation: number;
  kind?: { case: 'device'; value: DeviceWrap } | { case: 'pin'; value: PinWrap };
}

export function wrapFromJson(v: unknown): Wrap {
  const j = (v ?? {}) as Record<string, unknown>;
  const generation = pick(j, 'generation', 'generation');
  const out: Wrap = {
    generation: generation === undefined || generation === null ? 0 : Number(generation),
  };
  {
    const x = pick(j, 'device', 'device');
    if (x !== undefined && x !== null) out.kind = { case: 'device', value: deviceWrapFromJson(x) };
  }
  {
    const x = pick(j, 'pin', 'pin');
    if (x !== undefined && x !== null) out.kind = { case: 'pin', value: pinWrapFromJson(x) };
  }
  return out;
}

export function wrapToJson(m: Wrap): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.generation === 0)) j.generation = m.generation;
  if (m.kind?.case === 'device') j.device = deviceWrapToJson(m.kind.value);
  if (m.kind?.case === 'pin') j.pin = pinWrapToJson(m.kind.value);
  return j;
}

