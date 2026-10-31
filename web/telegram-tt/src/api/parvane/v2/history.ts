// Журнал истории аккаунта (spec 033, HIST-1, HIST-2, READ-2): клиентская сторона.
// Сервер (шард messenger) хранит зашифрованные записи; шифрует, пакует и разбирает их сессия движка
// (`PvClient.historySession()` → `PvHistory`), строки сводит хранилище строк (`historyRows.ts`). Здесь —
// жизненный цикл: очередь записи (свои действия ≤ 300 мс, маркер ≤ 1 с, входящее через случайные 1–5 с и только
// если его ещё нет в журнале), догон по живому уведомлению `JournalNotice` и страховочный опрос раз в 60 с, вход
// нового устройства (голова → сводка → сегменты → журнал после точки), контрольная точка (сегменты по чату и месяцу,
// неизменившиеся — прежним номером), замена истории дальше горизонта надгробий, перенос локальной истории (один
// раз) и защита от отката сервера.

import type { HistoryRows } from '../historyRows';
import type { PvHistory } from './engine';
import type { HOp, HReadMark, HRowState, HSegmentRef } from './historyModel';

import { base64ToBytes, bytesToBase64 } from './base64';
import { addressForPeer, opKey } from './historyModel';
import { V2Error } from './transport';

/** Что журналу истории нужно от v2-стека (контроллер). */
export type HistoryHost = {
  openSession: () => PvHistory | undefined;
  call: (method: string, body: Uint8Array) => Promise<Uint8Array>;
  log: (message: string) => void;
};

/** Сохраняемое состояние журнала на устройстве. */
export type HistorySyncState = {
  // Последняя применённая запись журнала (не сегмент)
  cursor: number;
  // Наибольшая виденная голова журнала — меньшая в ответе значит откат сервера
  headSeq: number;
  // Время последней полной синхронизации (курсор дошёл до головы), мс
  lastFullSyncMs: number;
  // Локальная история перенесена в журнал (FR-024)
  migrated?: boolean;
  checkpointId?: number;
  checkpointUpto?: number;
  checkpointCreatedMs?: number;
  // Сегменты текущей точки (ключ, отпечаток, номер) — неизменившиеся переходят в следующую
  segments?: { key: string; digest: string; seq: number }[];
  // Сегменты, запечатанные не текущим ключом/адресом: при следующей точке перезаливаются
  staleSegments?: number[];
  // Ключ личного состояния сменён: следующая точка перезаливает все сегменты (иначе новое устройство не прочтёт)
  forceReupload?: boolean;
  // Точка не принята сервером (её сменило другое устройство) — не повторять, пока не придёт новая
  casFailedFor?: number;
};

type IngestResult = {
  ops: HOp[];
  records: { seq: number; chunk: boolean; opId: string; first: number; count: number; stale: boolean }[];
  more: boolean;
  headSeq: number;
  compacted?: Checkpoint;
  rejected: number;
};
type Checkpoint = { id: number; uptoSeq: number; summarySeq: number; chunkSeqs: number[]; createdMs: number };
type QueueItem = { op: HOp; due: number; key?: string; markChat?: string };
type Outbox = { ops: QueueItem[]; bodies: string[] };

type Deps = {
  rows: HistoryRows;
  loadState: () => Promise<HistorySyncState | undefined>;
  saveState: (state: HistorySyncState) => Promise<void>;
  loadOutbox: () => Promise<Outbox | undefined>;
  saveOutbox: (outbox: Outbox) => Promise<void>;
  /** Строки устройства стёрты заменой — показ убрать (uuid). */
  onWiped?: (uuids: string[]) => void;
  /** Прежний учёт прочитанного (перенос, FR-024) — uuid прочитанных входящих; после переноса — стереть. */
  takeLegacyReadUuids?: () => string[];
  onMigrated?: () => void;
  /** Записи приняты сервером — другие вкладки этого браузера (то же устройство) догоняют сразу. */
  onWritten?: () => void;
  log: (message: string) => void;
  now?: () => number;
  random?: () => number;
};

export const HISTORY_OWN_DELAY_MS = 300;
export const HISTORY_MARK_DELAY_MS = 1000;
export const HISTORY_INCOMING_MIN_MS = 1000;
export const HISTORY_INCOMING_MAX_MS = 5000;
export const HISTORY_POLL_MS = 60000;
// Контрольная точка: записей после прежней точки больше порога либо точке больше суток; случайная задержка
export const CHECKPOINT_RECORDS = 5000;
export const CHECKPOINT_AGE_MS = 24 * 60 * 60 * 1000;
export const CHECKPOINT_JITTER_MS = 60000;
// Горизонт надгробий (FR-021)
export const TOMBSTONE_HORIZON_MS = 180 * 24 * 60 * 60 * 1000;
const SYNC_PAGES = 1000;
const GET_BATCH = 64;
const SEEN_LIMIT = 50000;
const SEAL_BATCH_OPS = 500;
// Часть сегмента: открытый текст записи ≤ 200 КиБ — режем заранее с запасом
const SEGMENT_PART_BYTES = 150 * 1024;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
const RATE_LIMIT_PAUSE_MS = 1000;
const RATE_LIMIT_RETRIES = 20;

export function createHistoryJournal(deps: Deps) {
  const now = deps.now || Date.now;
  const random = deps.random || Math.random;
  let host: HistoryHost | undefined;
  let session: PvHistory | undefined;
  // Свои адреса сессии (текущий и прежние после смены ника) — набор «своих» для непрочитанного
  let selves: string[] = [];
  let state: HistorySyncState = { cursor: 0, headSeq: 0, lastFullSyncMs: 0 };
  let queue: Promise<unknown> = Promise.resolve();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_BASE_MS;
  let generation = 0;
  let isSynced = false;
  let isRolledBack = false;
  // Операции, уже лежащие в журнале (id строки, метка мутации): входящее, которое другое устройство успело
  // записать, второй раз не пишется
  const seen = new Set<string>();
  const seenMarks = new Map<string, HReadMark>();
  let outbox: Outbox = { ops: [], bodies: [] };
  let outboxSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  function callSession<T>(name: string, args: unknown = {}): T {
    return JSON.parse(session!.call(name, JSON.stringify(args))) as T;
  }

  async function request(method: string, bodyB64: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return bytesToBase64(await host!.call(method, base64ToBytes(bodyB64)));
      } catch (e) {
        if (!(e instanceof V2Error) || e.code !== 'ERROR_CODE_RATE_LIMITED' || attempt >= RATE_LIMIT_RETRIES) throw e;
        await pause(RATE_LIMIT_PAUSE_MS);
      }
    }
  }

  function noteSeen(op: HOp) {
    const key = opKey(op);
    if (key) {
      seen.add(key);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
    }
    if (op.read) {
      const chat = addressForPeer(op.read.chat);
      if (chat) seenMarks.set(chat, op.read);
    }
    if (op.state?.row) seen.add(`r:${op.state.row.id}`);
  }

  async function saveState() {
    await deps.saveState({ ...state }).catch((e: unknown) => deps.log(`история: состояние не записано: ${String(e)}`));
  }

  // ── подключение ────────────────────────────────────────────────────────────

  /** Стек поднят (или ключ личного состояния сменён — `rekey`): сессия журнала, догон, перенос. */
  async function attach(nextHost: HistoryHost, rekey?: 'self' | 'peer') {
    detach();
    const nextSession = nextHost.openSession();
    if (!nextSession) {
      deps.log('история: журнал недоступен — нет ключа личного состояния');
      return;
    }
    host = nextHost;
    session = nextSession;
    try {
      selves = callSession<string[]>('selfAddresses');
    } catch (e) {
      deps.log(`история: свои адреса сессии не получены: ${String(e)}`);
    }
    const myGeneration = ++generation;
    state = { cursor: 0, headSeq: 0, lastFullSyncMs: 0, ...(await deps.loadState().catch(() => undefined)) };
    // Ключ сменило это устройство (отзыв другого): старые записи новым ключом не читаются — следующая точка
    // перезаливает все сегменты под новым ключом (иначе новое устройство не прочтёт историю)
    if (rekey === 'self') {
      state.forceReupload = true;
      await saveState();
    }
    // Очередь, сохранённая до перезагрузки, плюс то, что встало в неё до подключения журнала (без дублей)
    const saved = (await deps.loadOutbox().catch(() => undefined)) || { ops: [], bodies: [] };
    const known = new Set(saved.ops.map((item) => JSON.stringify(item.op)));
    outbox = {
      ops: [...saved.ops, ...outbox.ops.filter((item) => !known.has(JSON.stringify(item.op)))],
      bodies: Array.from(new Set([...saved.bodies, ...outbox.bodies])),
    };
    if (myGeneration !== generation) return;
    await deps.rows.ensureMarks();
    listenVisibility();
    deps.log('история: журнал подключён');
    await syncNow();
    scheduleFlush(0);
  }

  function detach() {
    generation++;
    [pollTimer, flushTimer, checkpointTimer].forEach((timer) => {
      if (timer) clearTimeout(timer);
    });
    pollTimer = undefined;
    flushTimer = undefined;
    checkpointTimer = undefined;
    session?.free();
    session = undefined;
    host = undefined;
    isSynced = false;
    isRolledBack = false;
  }

  function reset() {
    detach();
    selves = [];
    seen.clear();
    seenMarks.clear();
    outbox = { ops: [], bodies: [] };
    state = { cursor: 0, headSeq: 0, lastFullSyncMs: 0 };
  }

  let isVisibilityListened = false;
  function listenVisibility() {
    if (isVisibilityListened || typeof document === 'undefined') return;
    isVisibilityListened = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && session) void syncNow();
    });
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void syncNow();
    }, HISTORY_POLL_MS);
  }

  /** Живое уведомление `JournalNotice{HISTORY}`: другое своё устройство записало в журнал. */
  function onNotice() {
    if (session) void syncNow();
  }

  function syncNow() {
    return serial(async () => {
      try {
        // Перенос — до первого чтения журнала: в журнал уходит только то, что было на устройстве до него
        if (!state.migrated) {
          await migrate().catch((e: unknown) => deps.log(`история: перенос не завершён, повтор позже: ${String(e)}`));
        }
        await pull();
        scheduleCheckpoint();
      } catch (e) {
        deps.log(`история: синк журнала: ${String(e)}`);
      } finally {
        if (session) schedulePoll();
      }
    });
  }

  // ── чтение журнала ─────────────────────────────────────────────────────────

  async function pull() {
    if (!session || !host || isRolledBack) return;
    if (!state.cursor && !state.checkpointId) await bootstrap();
    for (let page = 0; page < SYNC_PAGES && session; page++) {
      const body = callSession<string>('syncRequest', { afterSeq: state.cursor, skipChunks: true });
      const resp = await request('history.sync', body);
      const r = callSession<IngestResult>('ingest', { resp });
      if (r.headSeq < state.headSeq) {
        isRolledBack = true;
        deps.log(`история: сервер вернул журнал назад (голова ${r.headSeq} < ${state.headSeq}) — не применяется`);
        return;
      }
      state.headSeq = Math.max(state.headSeq, r.headSeq);
      if (r.compacted && state.cursor < r.compacted.uptoSeq) {
        await loadCheckpoint(r.compacted, true);
      }
      if (r.rejected) deps.log(`история: ${r.rejected} записей журнала не открылись`);
      await deps.rows.applyJournalOps(r.ops);
      r.ops.forEach(noteSeen);
      r.records.forEach((record) => {
        if (!record.chunk && record.seq > state.cursor) state.cursor = record.seq;
      });
      if (!r.more || !r.records.length) {
        isSynced = true;
        state.lastFullSyncMs = now();
        break;
      }
    }
    await saveState();
  }

  /** Вход нового устройства (курсор 0): голова → точка (сводка, затем сегменты), дальше — обычный синк. */
  async function bootstrap() {
    const resp = await request('history.head', callSession<string>('headRequest'));
    const head = callSession<{ headSeq: number; checkpoint?: Checkpoint }>('ingestHead', { resp });
    state.headSeq = Math.max(state.headSeq, head.headSeq);
    if (head.checkpoint) await loadCheckpoint(head.checkpoint, false);
  }

  async function getRecords(seqs: number[]): Promise<IngestResult[]> {
    const out: IngestResult[] = [];
    let rest = seqs.slice();
    while (rest.length && session) {
      const batch = rest.slice(0, GET_BATCH);
      const resp = await request('history.get', callSession<string>('getRequest', { seqs: batch }));
      const r = callSession<IngestResult>('ingest', { resp });
      out.push(r);
      const got = new Set(r.records.map((record) => record.seq));
      // Страница ограничена размером: не поместившиеся — следующим запросом; пустой ответ — их на сервере нет
      const missing = batch.filter((seq) => !got.has(seq));
      rest = got.size ? [...missing, ...rest.slice(GET_BATCH)] : rest.slice(GET_BATCH);
    }
    return out;
  }

  /** Контрольная точка: сводка (список чатов, маркеры) сразу, сегменты — свежие первыми. `isCompacted` — точка из
   * ответа синка (журнал до неё свёрнут): дальше горизонта — замена истории, иначе сведение. */
  async function loadCheckpoint(cp: Checkpoint, isCompacted: boolean) {
    const [summaryResult] = await getRecords([cp.summarySeq]);
    const summary = summaryResult?.ops.find((op) => op.summary)?.summary;
    if (!summary) {
      deps.log(`история: сводка точки ${cp.id} не прочитана`);
      state.cursor = Math.max(state.cursor, cp.uptoSeq);
      return;
    }
    const tombstonesSinceMs = Number(summary.tombstones_since_ms || 0);
    if (isCompacted && callSession<boolean>('historyNeedsReplace', {
      lastFullSyncMs: state.lastFullSyncMs, tombstonesSinceMs, cursor: state.cursor, uptoSeq: cp.uptoSeq,
    })) {
      deps.log('история: устройство не синхронизировалось дольше горизонта — история заменяется точкой');
      const wiped = await deps.rows.wipe();
      deps.onWiped?.(wiped);
    }
    const chatOps: HOp[] = [];
    (summary.chats || []).forEach((chat) => {
      if (chat.last) chatOps.push({ state: chat.last });
      if (chat.mark) chatOps.push({ read: chat.mark });
    });
    await deps.rows.applyJournalOps(chatOps);
    deps.log(`история: сводка точки применена (чатов ${(summary.chats || []).length})`);
    const segments = orderSegments(summary.segments || []);
    const stale: number[] = [];
    for (let i = 0; i < segments.length; i += GET_BATCH) {
      const results = await getRecords(segments.slice(i, i + GET_BATCH).map((ref) => Number(ref.seq)));
      for (const r of results) {
        await deps.rows.applyJournalOps(r.ops);
        r.ops.forEach(noteSeen);
        r.records.filter((record) => record.stale).forEach((record) => stale.push(record.seq));
      }
    }
    if (segments.length) deps.log(`история: сегменты точки применены (${segments.length})`);
    state.cursor = Math.max(state.cursor, cp.uptoSeq);
    state.checkpointId = cp.id;
    state.checkpointUpto = cp.uptoSeq;
    state.checkpointCreatedMs = cp.createdMs;
    state.segments = (summary.segments || []).map((ref) => ({
      key: ref.key, digest: ref.digest || '', seq: Number(ref.seq),
    }));
    state.staleSegments = stale;
    state.casFailedFor = undefined;
    await saveState();
  }

  // ── запись ─────────────────────────────────────────────────────────────────

  /** Операция в очередь записи: своя — через ≤ 300 мс (маркер — ≤ 1 с), входящее — через 1–5 с, если её к тому
   * времени нет в журнале. */
  function enqueue(op: HOp, { isOwn }: { isOwn: boolean }) {
    const t = now();
    let due = t + HISTORY_OWN_DELAY_MS;
    if (op.read) due = t + HISTORY_MARK_DELAY_MS;
    else if (!isOwn) due = t + HISTORY_INCOMING_MIN_MS + random() * (HISTORY_INCOMING_MAX_MS - HISTORY_INCOMING_MIN_MS);
    const markChat = op.read ? addressForPeer(op.read.chat) : undefined;
    if (markChat) outbox.ops = outbox.ops.filter((item) => item.markChat !== markChat);
    outbox.ops.push({
      op, due, key: isOwn ? undefined : opKey(op), markChat,
    });
    saveOutboxSoon();
    scheduleFlush(due - t);
  }

  function saveOutboxSoon() {
    if (outboxSaveTimer) return;
    outboxSaveTimer = setTimeout(() => {
      outboxSaveTimer = undefined;
      void deps.saveOutbox(outbox).catch(() => undefined);
    }, HISTORY_OWN_DELAY_MS);
  }

  function scheduleFlush(delayMs: number) {
    if (!session) return;
    if (flushTimer) clearTimeout(flushTimer);
    const nextDue = outbox.ops.length ? Math.min(...outbox.ops.map((item) => item.due)) - now() : Infinity;
    const delay = Math.max(0, Math.min(delayMs, outbox.bodies.length ? 0 : nextDue));
    if (!Number.isFinite(delay)) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void serial(flush).catch((e: unknown) => deps.log(`история: запись в журнал: ${String(e)}`));
    }, delay);
  }

  function isMarkInJournal(mark: HReadMark) {
    const chat = addressForPeer(mark.chat);
    const known = chat ? seenMarks.get(chat) : undefined;
    if (!known) return false;
    const a = Number(known.up_to_ts_ms);
    const b = Number(mark.up_to_ts_ms);
    return a > b || (a === b && known.up_to_id >= mark.up_to_id);
  }

  async function flush() {
    if (!session || !host) return;
    const t = now();
    const due = outbox.ops.filter((item) => item.due <= t);
    outbox.ops = outbox.ops.filter((item) => item.due > t);
    const ops = due
      .filter((item) => !(item.key && seen.has(item.key)) && !(item.op.read && isMarkInJournal(item.op.read)))
      .map((item) => item.op);
    for (let i = 0; i < ops.length; i += SEAL_BATCH_OPS) {
      outbox.bodies.push(...sealOps(ops.slice(i, i + SEAL_BATCH_OPS)));
    }
    try {
      let written = 0;
      while (outbox.bodies.length && session) {
        await appendBody(outbox.bodies[0]);
        outbox.bodies.shift();
        written += 1;
      }
      ops.forEach(noteSeen);
      retryDelay = RETRY_BASE_MS;
      // Маркер для сценариев и диагностики: операции устройства уже в журнале аккаунта
      if (written) {
        deps.log(`история: в журнал записано (записей ${written}, операций ${ops.length})`);
        deps.onWritten?.();
      }
    } catch (e) {
      deps.log(`история: запись не принята, повтор через ${retryDelay / 1000} с: ${String(e)}`);
      setTimeout(() => scheduleFlush(0), retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    } finally {
      await deps.saveOutbox(outbox).catch(() => undefined);
    }
    if (outbox.ops.length) scheduleFlush(Infinity);
  }

  // Пачка не запечаталась (движок отверг операцию) — по одной, чтобы одна негодная не теряла остальные
  function sealOps(ops: HOp[]): string[] {
    try {
      return callSession<{ opId: string; body: string }[]>('seal', { ops }).map((sealed) => sealed.body);
    } catch {
      return ops.flatMap((op) => {
        try {
          return callSession<{ opId: string; body: string }[]>('seal', { ops: [op] }).map((sealed) => sealed.body);
        } catch (e) {
          deps.log(`история: операция не запечатана: ${String(e)}`);
          return [];
        }
      });
    }
  }

  async function appendBody(body: string): Promise<number | undefined> {
    try {
      const resp = await request('history.append', body);
      return callSession<{ seq: number }>('ingestAppend', { resp }).seq;
    } catch (e) {
      // Та же операция уже записана (повтор после обрыва другим шифртекстом) — считается записанной
      if (e instanceof V2Error && e.code === 'ERROR_CODE_DUPLICATE') return undefined;
      // Отказ, после которого повтор бессмысленен, — запись снимается, а не держит очередь
      if (e instanceof V2Error && e.code === 'ERROR_CODE_INVALID') {
        deps.log('история: запись отвергнута сервером (INVALID) и снята с очереди');
        return undefined;
      }
      throw e;
    }
  }

  async function appendOne(op: HOp | HOp[], isChunk: boolean): Promise<number[]> {
    const sealed = callSession<{ opId: string; body: string }[]>('seal', {
      ops: Array.isArray(op) ? op : [op], chunk: isChunk,
    });
    const seqs: number[] = [];
    for (const { body } of sealed) {
      const seq = await appendBody(body);
      if (seq === undefined) throw new Error('сегмент не записан');
      seqs.push(seq);
    }
    return seqs;
  }

  // ── перенос локальной истории (FR-024, один раз) ───────────────────────────

  async function migrate() {
    if (!session) return;
    const states = await deps.rows.collectStates();
    const readUuids = new Set(deps.takeLegacyReadUuids?.() || []);
    const marks = await deps.rows.legacyMarks(readUuids);
    const ops: HOp[] = states.map((s) => ({ state: s }));
    for (let i = 0; i < ops.length; i += SEAL_BATCH_OPS) {
      await appendOne(ops.slice(i, i + SEAL_BATCH_OPS), false);
    }
    ops.forEach(noteSeen);
    state.migrated = true;
    await saveState();
    deps.onMigrated?.();
    deps.log(`история: локальная история перенесена в журнал (строк ${states.length}, маркеров ${marks})`);
  }

  // ── контрольная точка (HIST-2) ─────────────────────────────────────────────

  function isCheckpointDue() {
    if (!isSynced || !state.migrated) return false;
    if (state.casFailedFor !== undefined && state.casFailedFor === (state.checkpointId || 0)) return false;
    if (state.forceReupload) return true;
    const after = state.headSeq - (state.checkpointUpto || 0);
    if (after <= 0) return false;
    if (after > CHECKPOINT_RECORDS) return true;
    // Первой точки ещё нет: короткий журнал новое устройство прочтёт целиком — точка по числу записей
    if (!state.checkpointId) return false;
    return now() - (state.checkpointCreatedMs || 0) > CHECKPOINT_AGE_MS;
  }

  function scheduleCheckpoint() {
    if (checkpointTimer || !isCheckpointDue()) return;
    checkpointTimer = setTimeout(() => {
      checkpointTimer = undefined;
      void serial(buildCheckpoint).catch((e: unknown) => deps.log(`история: контрольная точка: ${String(e)}`));
    }, random() * CHECKPOINT_JITTER_MS);
  }

  async function refreshHead() {
    const resp = await request('history.head', callSession<string>('headRequest'));
    const head = callSession<{ headSeq: number; checkpoint?: Checkpoint }>('ingestHead', { resp });
    if (head.checkpoint && head.checkpoint.id !== state.checkpointId) {
      // Точку сменило другое устройство: её сегменты — основа следующей (с прежними номерами)
      const [summaryResult] = await getRecords([head.checkpoint.summarySeq]);
      const summary = summaryResult?.ops.find((op) => op.summary)?.summary;
      state.checkpointId = head.checkpoint.id;
      state.checkpointUpto = head.checkpoint.uptoSeq;
      state.checkpointCreatedMs = head.checkpoint.createdMs;
      state.segments = (summary?.segments || []).map((ref) => ({
        key: ref.key, digest: ref.digest || '', seq: Number(ref.seq),
      }));
      state.casFailedFor = undefined;
    }
  }

  async function buildCheckpoint() {
    if (!session || !host) return;
    await refreshHead();
    await pull();
    if (!isCheckpointDue() || !session) return;
    const snapshotCursor = state.cursor;
    const nowMs = now();
    const states = callSession<HRowState[]>('historyCompact', { states: await deps.rows.collectStates(), nowMs });
    const parts = splitSegments(states);
    const stale = new Set(state.staleSegments || []);
    const refs: HSegmentRef[] = [];
    let uploaded = 0;
    for (const part of parts) {
      const digest = callSession<string>('historySegmentDigest', { states: part.states });
      const prevSeg = state.forceReupload ? undefined
        : state.segments?.find((s) => s.key === part.key && s.digest === digest && !stale.has(s.seq));
      if (prevSeg) {
        refs.push({ key: part.key, digest, seq: prevSeg.seq });
        continue;
      }
      const seqs = await appendOne(part.states.map((s) => ({ state: s })), true);
      uploaded += 1;
      if (seqs.length === 1) refs.push({ key: part.key, digest, seq: seqs[0] });
      else seqs.forEach((seq, i) => refs.push({ key: `${part.key}~${i}`, digest: '', seq }));
    }
    const summaryOp = callSession<HOp>('historySummary', {
      chats: deps.rows.summarizeChats(states), segments: refs, tombstonesSinceMs: nowMs - TOMBSTONE_HORIZON_MS,
    });
    const [summarySeq] = await appendOne(summaryOp, true);
    // Пока точка собиралась, другое устройство могло дописать журнал: такие записи вошли бы под обрезку
    const checkResp = await request('history.sync', callSession<string>('syncRequest', {
      afterSeq: snapshotCursor, skipChunks: true,
    }));
    const check = callSession<IngestResult>('ingest', { resp: checkResp });
    if (check.records.some((record) => record.seq <= summarySeq)) {
      deps.log('история: журнал дописан во время сборки точки — точка отложена');
      return;
    }
    const expected = state.checkpointId || 0;
    try {
      const resp = await request('history.checkpoint.commit', callSession<string>('commitRequest', {
        expected, uptoSeq: summarySeq, summarySeq, chunkSeqs: refs.map((ref) => Number(ref.seq)),
      }));
      const { checkpointId } = callSession<{ checkpointId: number }>('ingestCommit', { resp });
      state.checkpointId = checkpointId;
      state.checkpointUpto = summarySeq;
      state.checkpointCreatedMs = nowMs;
      state.segments = refs.map((ref) => ({ key: ref.key, digest: ref.digest || '', seq: Number(ref.seq) }));
      state.staleSegments = [];
      state.forceReupload = false;
      state.cursor = Math.max(state.cursor, summarySeq);
      state.casFailedFor = undefined;
      deps.log(`история: контрольная точка ${checkpointId} (сегментов ${refs.length}, перезалито ${uploaded})`);
    } catch (e) {
      if (!(e instanceof V2Error) || e.code !== 'ERROR_CODE_DUPLICATE') throw e;
      state.casFailedFor = expected;
      deps.log('история: точку уже сменило другое устройство — не повторяем до новой');
    }
    await saveState();
  }

  function splitSegments(states: HRowState[]) {
    const byKey = new Map<string, HRowState[]>();
    states.forEach((s) => {
      const key = callSession<string>('historySegmentKey', { state: s });
      const list = byKey.get(key) || [];
      list.push(s);
      byKey.set(key, list);
    });
    const parts: { key: string; states: HRowState[] }[] = [];
    byKey.forEach((list, key) => {
      list.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
      let current: HRowState[] = [];
      let size = 0;
      let index = 0;
      list.forEach((s) => {
        const len = JSON.stringify(s).length;
        if (current.length && size + len > SEGMENT_PART_BYTES) {
          parts.push({ key: index ? `${key}#${index}` : key, states: current });
          index += 1;
          current = [];
          size = 0;
        }
        current.push(s);
        size += len;
      });
      if (current.length) parts.push({ key: index ? `${key}#${index}` : key, states: current });
    });
    return parts;
  }

  return {
    attach,
    detach,
    reset,
    enqueue,
    onNotice,
    syncNow,
    isAttached: () => Boolean(session),
    /** Свои адреса сессии журнала (текущий и прежние); до подключения — пусто. */
    selfAddresses: () => selves.slice(),
    /** Для тестов и диагностики: состояние журнала на устройстве. */
    getState: () => ({ ...state }),
    flushNow: () => serial(flush),
  };
}

export type HistoryJournal = ReturnType<typeof createHistoryJournal>;

/** Сегменты — свежие месяцы первыми (ключ «чат|ГГГГ-ММ[#часть]»). */
export function orderSegments(refs: HSegmentRef[]) {
  const month = (key: string) => (key.split('|')[1] || '').replace(/[#~].*$/, '');
  return refs.slice().sort((a, b) => {
    const am = month(a.key);
    const bm = month(b.key);
    if (am !== bm) return am < bm ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

function pause(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
