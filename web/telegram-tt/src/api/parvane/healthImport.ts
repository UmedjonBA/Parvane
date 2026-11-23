import { unzipSync } from 'fflate';

import type { HealthSync } from './v2/health';

import { bytesToBase64 } from './v2/base64';

// Импорт «Здоровья» из выгрузки Health Connect (Android: Health Connect → «Экспорт данных»): файл — архив
// `health_connect_export.zip` (внутри база `health_connect_export.db`) либо сама база. Разбор и отсев уже
// имеющихся записей — в движке; здесь — распаковка и запись пачками. Предпросмотр держит записи до «Импортировать»

export type HealthImportPreview = {
  token: string;
  total: number;
  counts: Record<string, number>;
  firstDay?: string;
  lastDay?: string;
};

export type HealthImportError = 'not_export' | 'corrupt' | 'too_big' | 'engine';

const DB_NAME = 'health_connect_export.db';
// Выгрузка больше — отказ (база гоняется в движок строкой base64: копии в памяти)
const MAX_DB_BYTES = 200 * 1024 * 1024;
// Записей за одно изменение домена — не больше: огромное изменение долго пишется и сводится
const APPLY_BATCH = 500;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

let pending: { token: string; entries: unknown[] } | undefined;

export function createHealthImport(deps: { health: () => HealthSync; log: (message: string) => void }) {
  return {
    /** Разобрать файл выгрузки: что и сколько будет добавлено; `error` — не выгрузка, повреждена, слишком большая. */
    async parvaneHealthImportPreview(
      { file }: { file: Blob },
    ): Promise<HealthImportPreview | { error: HealthImportError }> {
      pending = undefined;
      const db = extractDb(new Uint8Array(await file.arrayBuffer()));
      if (!db) return { error: 'not_export' };
      if (db.byteLength > MAX_DB_BYTES) return { error: 'too_big' };
      const json = deps.health().importHealthConnect(bytesToBase64(db));
      if (!json) return { error: 'engine' };
      const result = JSON.parse(json) as {
        error?: HealthImportError;
        entries?: unknown[];
        counts?: Record<string, number>;
        firstDay?: string;
        lastDay?: string;
      };
      if (result.error) return { error: result.error };
      const token = String(Date.now());
      pending = { token, entries: result.entries || [] };
      return {
        token,
        total: pending.entries.length,
        counts: result.counts || {},
        firstDay: result.firstDay,
        lastDay: result.lastDay,
      };
    },

    /** Записать разобранное (по токену предпросмотра) пачками; ответ — сколько записано. */
    async parvaneHealthImportApply({ token }: { token: string }) {
      if (pending?.token !== token) return 0;
      const { entries } = pending;
      pending = undefined;
      const health = deps.health();
      for (let at = 0; at < entries.length; at += APPLY_BATCH) {
        health.apply(entries.slice(at, at + APPLY_BATCH).map((entry) => ({ entry })));
        await health.flush();
      }
      deps.log(`здоровье: импортировано из Health Connect ${entries.length} записей`);
      return entries.length;
    },

    /** Отказ от предпросмотра: разобранное не хранится. */
    parvaneHealthImportCancel() {
      pending = undefined;
      return Promise.resolve(true);
    },
  };
}

/** База из архива выгрузки либо сама база; не то — `undefined`. */
function extractDb(bytes: Uint8Array): Uint8Array | undefined {
  if (!ZIP_MAGIC.every((b, i) => bytes[i] === b)) return bytes;
  try {
    const files = unzipSync(bytes, { filter: (entry) => entry.name.endsWith(DB_NAME) });
    return Object.values(files)[0];
  } catch {
    return undefined;
  }
}
