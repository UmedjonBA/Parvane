// Хранилище строк истории (spec 033, HIST-1, READ-2): каждое событие истории — приём, отправка, действие
// пользователя, запись журнала — сводится движком в `RowState` строки (`m:<uuid>`, поле `hs`), а показ берёт вид
// этого состояния. Удалённое остаётся надгробием и больше не показывается ни из какого источника; мутация раньше
// сообщения хранится сиротой и применяется, когда сообщение придёт (в любом порядке инбокса и журнала). Маркер
// «прочитано до» по чату — здесь же; непрочитанное считает движок от маркера.

import type { MessageIndex } from './v2/messageIndex';
import type { WireStoredMessage } from './wire';

import {
  addressForPeer, applyEditPatch, applyOp, canDelete, compareMarkPoint, decodeBody, type HOp, type HReadMark,
  type HRowState, isAfterMark,
  isGroupPeer, isJournalable, isUnreadRow, legacyState, markMerge, nonCountedKinds, opTarget, peerForAddress,
  rowTsMs, storedFromState,
} from './v2/historyModel';

export type HistorySource = 'own' | 'inbox' | 'journal';

export type HistoryIngestContext = {
  source: HistorySource;
  // Автор мутации (для проверки прав по известной строке) и его право удалять чужое в группе
  author?: string;
  isAdmin?: boolean;
  // Пакетный перенос (журнал, точка): сброс кэша на диск и пересчёт счётчиков — в конце пачки
  isBulk?: boolean;
};

export type HistoryJournalSink = {
  enqueue: (op: HOp, opts: { isOwn: boolean }) => void;
};

type Deps = {
  self: () => string;
  /** Свои адреса из сессии журнала движка (`selfAddresses`: текущий и прежние после смены ника, spec 026); свои
   * строки под прежним адресом — свои (не входящие, сдвигают маркер, «мои» реакции). Пусто — только `self`. */
  selves?: () => string[];
  domain: () => string;
  index: MessageIndex;
  loadAll: () => Promise<WireStoredMessage[]>;
  saveRecord: (stored: WireStoredMessage) => void;
  deleteRecord: (uuid: string) => void;
  updateOwnJournal: (stored: WireStoredMessage) => void;
  flush: () => Promise<void>;
  /** Показать строку (вид состояния) без записи в кэш — запись делает хранилище строк. */
  show: (stored: WireStoredMessage) => Promise<void>;
  /** Счётчики этих чатов пересчитать от маркера (пачка журнала, сдвиг маркера). */
  onChatsTouched: (addresses: string[]) => void;
  loadMarks: () => Promise<Record<string, HReadMark>>;
  saveMark: (address: string, mark: HReadMark) => void;
  loadClearedUntil: () => Record<string, number>;
  journal: () => HistoryJournalSink | undefined;
  log: (message: string) => void;
};

export type RowMeta = { id: string; chat: string; from: string; tsMs: number; kind: string };

export function createHistoryRows(deps: Deps) {
  const chains = new Map<string, Promise<unknown>>();
  let marks = new Map<string, HReadMark>();
  let marksLoaded: Promise<void> | undefined;
  let marksOwner = '';

  /** Набор своих адресов: текущий первым, затем прежние. */
  function ownAddresses() {
    const self = deps.self();
    const all = [self, ...(deps.selves?.() || [])].filter(Boolean);
    return Array.from(new Set(all));
  }

  function ownChecker() {
    const own = new Set(ownAddresses());
    return (address: string | undefined) => Boolean(address && own.has(address));
  }

  function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    }).catch(() => undefined);
    return next;
  }

  function chatPeerOf(op: HOp) {
    return op.row?.chat || op.gone?.chat || op.edit?.chat || op.react?.chat || op.pin?.chat || op.state?.chat;
  }

  /** Применить операцию к строке. Возвращает строку после применения (undefined — отвергнута/без цели). */
  function ingest(op: HOp, ctx: HistoryIngestContext): Promise<WireStoredMessage | undefined> {
    const target = opTarget(op);
    if (!target) return Promise.resolve(undefined);
    return serialize(target, () => ingestUnserialized(target, op, ctx));
  }

  async function ingestUnserialized(target: string, op: HOp, ctx: HistoryIngestContext) {
    const self = deps.self();
    const isOwn = ownChecker();
    const prev = await deps.index.find(target);
    // Сообщение вне журнала (самоуничтожение, заглушка нечитаемого вида): мутация — прямо по строке, как раньше
    if (prev && !prev.hs && !prev.deleted && !isJournalable(prev)) {
      if (ctx.source === 'journal' || !isAllowedOutsideJournal(op, prev, ctx)) return undefined;
      const patched = patchOutsideJournal(prev, op, isOwn);
      if (!patched) return undefined;
      deps.index.set(patched);
      deps.saveRecord(patched);
      if (!ctx.isBulk) await deps.flush();
      await deps.show(patched);
      return patched;
    }
    const chat = chatPeerOf(op);
    let base = prev?.hs;
    if (!base && prev && chat) base = legacyState(prev, chat);
    // Права (автор правки, право удаления) проверяет движок по полям `by`/`by_admin` операции — и когда строка
    // придёт позже мутации: недействительная мутация не применяется ни в каком порядке (HIST-1)
    let next: HRowState;
    try {
      next = applyOp(base, op);
    } catch (e) {
      // Сирота другого чата (мутация с чужим id раньше сообщения) не должна заслонить само сообщение
      if (!op.row || !base || base.row) {
        deps.log(`история: операция над ${target} не применена: ${String(e)}`);
        return undefined;
      }
      next = applyOp(undefined, op);
    }
    if (prev?.hs && JSON.stringify(prev.hs) === JSON.stringify(next)) return prev;
    const stored = storedFromState(next, prev, self, isOwn);
    if (!stored) return undefined;
    deps.index.set(stored);
    deps.saveRecord(stored);
    if (isOwn(stored.from)) deps.updateOwnJournal(stored);
    if (!ctx.isBulk) await deps.flush();
    await deps.show(stored);
    const isJournaled = op.row ? !stored.deleted && isJournalable(stored) : true;
    if (ctx.source !== 'journal' && isJournaled) {
      deps.journal()?.enqueue(op, { isOwn: ctx.source === 'own' });
    }
    return stored;
  }

  /** Пачка операций журнала (или точки): строки — в хранилище и на экран, маркеры — сведением; счётчики чатов
   * пачки пересчитываются от маркеров один раз в конце (перенос не прибавляет к непрочитанному, FR-013). */
  async function applyJournalOps(ops: HOp[]) {
    const touched = new Set<string>();
    for (const op of ops) {
      if (op.read) {
        await applyMark(op.read, 'journal');
        continue;
      }
      if (op.summary) continue;
      const stored = await ingest(op, { source: 'journal', isBulk: true });
      const address = stored && addressForPeer(stored.hs?.chat);
      if (address) touched.add(address);
    }
    await deps.flush();
    if (touched.size) deps.onChatsTouched(Array.from(touched));
    return touched.size;
  }

  // ── маркеры «прочитано до» ────────────────────────────────────────────────

  function ensureMarks() {
    const self = deps.self();
    if (marksOwner !== self) {
      marksOwner = self;
      marks = new Map();
      marksLoaded = undefined;
    }
    if (!marksLoaded) {
      marksLoaded = deps.loadMarks().then((loaded) => {
        Object.entries(loaded).forEach(([address, mark]) => {
          marks.set(address, markMerge(marks.get(address), mark) || mark);
        });
      }).catch(() => undefined);
    }
    return marksLoaded;
  }

  function getMark(address: string) {
    return marks.get(address);
  }

  async function applyMark(mark: HReadMark, source: HistorySource) {
    const address = addressForPeer(mark.chat);
    if (!address) return false;
    await ensureMarks();
    const old = marks.get(address);
    let merged: HReadMark | undefined;
    try {
      merged = markMerge(old, mark);
    } catch (e) {
      deps.log(`история: маркер ${address} не принят: ${String(e)}`);
      return false;
    }
    if (!merged || (old && JSON.stringify(old) === JSON.stringify(merged))) return false;
    marks.set(address, merged);
    deps.saveMark(address, merged);
    if (source !== 'journal') deps.journal()?.enqueue({ read: merged }, { isOwn: true });
    deps.onChatsTouched([address]);
    return true;
  }

  /** Сдвинуть маркер чата до строки (прочтение, своё отправленное, копия своей квитанции). */
  async function advanceMark(address: string, tsMs: number, id: string, source: HistorySource = 'own') {
    const chat = peerForAddress(address, deps.domain());
    if (!chat || !id) return false;
    return applyMark({ chat, up_to_ts_ms: String(Math.floor(tsMs)), up_to_id: id.toLowerCase() }, source);
  }

  /** Входящее непрочитано: строго после маркера чата и движок считает его непрочитанным. */
  function isUnread(meta: RowMeta) {
    const selves = ownAddresses();
    if (!meta.from || selves.includes(meta.from) || nonCountedKinds().has(meta.kind)) return false;
    const mark = marks.get(meta.chat);
    if (!isAfterMark(mark, meta.tsMs, meta.id)) return false;
    const chat = peerForAddress(meta.chat, deps.domain());
    if (!chat) return false;
    try {
      return isUnreadRow({ ...meta, chat }, mark, selves);
    } catch {
      return false;
    }
  }

  // ── состояния для контрольной точки и переноса ────────────────────────────

  /** Все строки устройства как `RowState` (кэш прежних версий — сводимым состоянием); без очищенных чатов. */
  async function collectStates(): Promise<HRowState[]> {
    const records = await deps.loadAll();
    const cleared = deps.loadClearedUntil();
    const domain = deps.domain();
    const out = new Map<string, HRowState>();
    records.forEach((stored) => {
      if (out.has(stored.id)) return;
      const address = stored.hs ? addressForPeer(stored.hs.chat) : chatAddressOf(stored);
      const chat = address ? peerForAddress(address, domain) : undefined;
      if (!address || !chat) return;
      const state = stored.hs || legacyState(stored, chat);
      if (!state) return;
      const tsMs = Number(state.row?.ts_ms || 0);
      if (tsMs && tsMs <= (cleared[address] || 0)) return;
      out.set(stored.id, state);
    });
    return Array.from(out.values());
  }

  function chatAddressOf(stored: WireStoredMessage) {
    const isOwn = ownChecker();
    if (stored.to.startsWith('v2g:')) return stored.to;
    if (stored.from && !isOwn(stored.from)) return stored.from;
    return stored.to;
  }

  /** Сводка по чатам для точки: последняя видимая строка, маркер, число непрочитанных и строк. */
  function summarizeChats(states: HRowState[]) {
    const byChat = new Map<string, { last?: HRowState; unread: number; rows: number }>();
    const kinds = nonCountedKinds();
    const selves = ownAddresses();
    states.forEach((state) => {
      const address = addressForPeer(state.chat);
      if (!address) return;
      const entry = byChat.get(address) || { unread: 0, rows: 0 };
      entry.rows += 1;
      const row = state.row;
      if (row && !state.gone && row.body) {
        const tsMs = Number(row.ts_ms);
        const lastRow = entry.last?.row;
        if (!lastRow || compareMarkPoint(tsMs, row.id, Number(lastRow.ts_ms), lastRow.id) > 0) entry.last = state;
        const kind = kindOfBody(row.body);
        if (!selves.includes(row.from) && kind && !kinds.has(kind) && isAfterMark(marks.get(address), tsMs, row.id)
          && isUnreadRow({ id: row.id, chat: state.chat, from: row.from, tsMs, kind }, marks.get(address), selves)) {
          entry.unread += 1;
        }
      }
      byChat.set(address, entry);
    });
    return Array.from(byChat.entries()).map(([address, entry]) => ({
      chat: entry.last?.chat || peerForAddress(address, deps.domain())!,
      last: entry.last,
      mark: marks.get(address),
      unread: entry.unread,
      rows: entry.rows,
    })).filter((chat) => Boolean(chat.chat));
  }

  /** Маркеры по прежнему учёту прочитанного (перенос, FR-024): по чату — самая поздняя прочитанная входящая и
   * самое позднее своё сообщение. */
  async function legacyMarks(readUuids: Set<string>) {
    const records = await deps.loadAll();
    const isOwnAddress = ownChecker();
    const best = new Map<string, { tsMs: number; id: string }>();
    records.forEach((stored) => {
      if (stored.deleted || !stored.from || !isJournalable(stored)) return;
      const isOwn = isOwnAddress(stored.from);
      if (!isOwn && !stored.read && !readUuids.has(stored.id)) return;
      const address = chatAddressOf(stored);
      const tsMs = rowTsMs(stored);
      const current = best.get(address);
      if (!current || compareMarkPoint(tsMs, stored.id, current.tsMs, current.id) > 0) {
        best.set(address, { tsMs, id: stored.id });
      }
    });
    for (const [address, point] of best) {
      await advanceMark(address, point.tsMs, point.id, 'own');
    }
    return best.size;
  }

  /** Замена истории точкой (устройство дольше горизонта надгробий без синхронизации): локальные строки
   * стираются, показ — заново из точки. */
  async function wipe() {
    const records = await deps.loadAll();
    records.forEach((stored) => {
      deps.deleteRecord(stored.id);
      deps.index.remove(stored.id);
    });
    await deps.flush();
    return records.map((stored) => stored.id);
  }

  function reset() {
    chains.clear();
    marks = new Map();
    marksLoaded = undefined;
    marksOwner = '';
  }

  return {
    ingest,
    applyJournalOps,
    applyMark,
    advanceMark,
    ensureMarks,
    getMark,
    isUnread,
    ownAddresses,
    collectStates,
    summarizeChats,
    legacyMarks,
    wipe,
    reset,
  };
}

export type HistoryRows = ReturnType<typeof createHistoryRows>;

// Строка вне журнала (самоуничтожение, заглушка) движком не сводится — то же правило прав здесь: правка — только
// автор, удаление — `historyCanDelete`
function isAllowedOutsideJournal(op: HOp, prev: WireStoredMessage, ctx: HistoryIngestContext) {
  if (ctx.source === 'own' || !ctx.author) return true;
  if (op.edit) return prev.from === ctx.author;
  if (!op.gone) return true;
  const isGroup = isGroupPeer(op.gone.chat);
  return canDelete(isGroup ? 'group' : 'user', prev.from, ctx.author, ctx.isAdmin);
}

// Мутация строки вне журнала (самоуничтожение, заглушка): поля строки напрямую, без сведения
function patchOutsideJournal(
  prev: WireStoredMessage, op: HOp, isOwn: (address: string) => boolean,
): WireStoredMessage | undefined {
  if (op.gone) return { ...prev, deleted: true };
  if (op.pin) return { ...prev, pinned: Boolean(op.pin.pinned) || undefined };
  if (op.edit) {
    const body = decodeBody(op.edit.body);
    if (!body) return undefined;
    const content = body.content && typeof body.content === 'object'
      ? body.content as WireStoredMessage['content']
      : applyEditPatch(prev.content, (body.edit_patch || {}));
    return { ...prev, content, edited: true };
  }
  if (op.react) {
    const { user, emoji } = op.react;
    const reactors = (prev.reactors || []).filter((r) => r.user !== user);
    if (emoji) reactors.push({ user, emoji, ts: Math.floor(Number(op.react.stamp.ts_ms) / 1000) });
    const counts = new Map<string, { count: number; mine?: boolean }>();
    reactors.forEach((r) => {
      const c = counts.get(r.emoji) || { count: 0 };
      c.count += 1;
      if (isOwn(r.user)) c.mine = true;
      counts.set(r.emoji, c);
    });
    const reactions = Array.from(counts, ([e, c]) => ({ emoji: e, count: c.count, mine: c.mine }));
    return { ...prev, reactors, reactions };
  }
  return undefined;
}

function kindOfBody(body: string) {
  try {
    const parsed = JSON.parse(atob(body)) as { content?: { kind?: unknown } };
    return typeof parsed.content?.kind === 'string' ? parsed.content.kind : undefined;
  } catch {
    return undefined;
  }
}
