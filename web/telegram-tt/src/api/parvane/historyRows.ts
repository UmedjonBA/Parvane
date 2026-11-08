// Строки истории (spec 033 HIST-1, READ-2; spec 035 T114): строками владеет модель движка (`rowsApply`/`rowsAll`,
// `historyPage`, `chatList` в режиме хоста). Каждое событие истории — приём, отправка, действие пользователя, запись
// журнала, квитанция, очистка — уходит модели операцией; сведение (`RowState`, надгробия, сироты), место в ленте
// (ORDER-1), маркеры «прочитано до» и хранение — в модели, показ — из её представлений (`MessageView` с содержимым
// в виде web, `wire`). Своей копии строк у web нет; в памяти — только индекс показанного (`MessageIndex`) и копия
// маркеров для подсчёта непрочитанного. Журнал истории аккаунта по-прежнему пишет web (`v2/history.ts`).
//
// Вне модели — только строки самоуничтожения собеседника (в памяти сессии, как раньше вне кэша) и шифртекст v1.

import type { MessageIndex } from './v2/messageIndex';
import type { WireMessageContent, WireReactor, WireStoredMessage } from './wire';

import { b64ToUuid, uuidToB64 } from './v2/contentMap';
import {
  addressForPeer, applyEditPatch, canDelete, compareMarkPoint, decodeBody, type HOp, type HPeer, type HReadMark,
  type HRowState, isAfterMark, isJournalable, isUnreadRow, legacyState, nonCountedKinds, opTarget, peerForAddress,
  rowOpFromStored, rowTsMs,
} from './v2/historyModel';

const V2_GROUP_ADDRESS_PREFIX = 'v2g:';
const MS_IN_SECOND = 1000;
// Операций в одном вызове модели (граница — 4 МБ JSON)
const APPLY_CHUNK = 200;
const PAGE_MAX = 200;

export type HistorySource = 'own' | 'inbox' | 'journal';

export type HistoryIngestContext = {
  source: HistorySource;
  // Автор мутации (для проверки прав по известной строке) и его право удалять чужое в группе
  author?: string;
  isAdmin?: boolean;
  // Пакетный перенос (журнал, точка)
  isBulk?: boolean;
};

export type HistoryJournalSink = {
  enqueue: (op: HOp, opts: { isOwn: boolean }) => void;
};

type ModelOutcome = Record<string, unknown>;

/** Представление строки модели (proto3-JSON `MessageView`). */
export type RawMessageView = {
  id?: string;
  chat?: HPeer;
  from?: string;
  ts_ms?: string | number;
  edited_ts_ms?: string | number;
  outgoing?: boolean;
  disposition?: string;
  reply_to?: string;
  reactions?: { emoji?: string; count?: number; mine?: boolean }[];
  pinned?: boolean;
  delivery?: string;
  order?: string | number;
  wire?: string;
};

export type RowsAll = { views?: RawMessageView[]; states?: HRowState[]; marks?: HReadMark[] };

/** Строки модели профиля (хост модели `ModelHost`). */
export type RowsModel = {
  /** `rowsApply` — итог (`Outcome`) с изменениями показа. */
  apply: (args: Record<string, unknown>) => Promise<ModelOutcome>;
  all: (what: { views?: boolean; states?: boolean; marks?: boolean }) => Promise<RowsAll>;
  /** `historyPage` / `chatList` модели. */
  view: (name: 'historyPage' | 'chatList', args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type Deps = {
  self: () => string;
  /** Свои адреса из сессии журнала движка (`selfAddresses`: текущий и прежние после смены ника, spec 026); свои
   * строки под прежним адресом — свои (не входящие, сдвигают маркер, «мои» реакции). Пусто — только `self`. */
  selves?: () => string[];
  domain: () => string;
  index: MessageIndex;
  /** Модель профиля; нет — ещё не открыта (вход без сети до первого подключения) либо нет профиля. */
  model: () => Promise<RowsModel | undefined>;
  /** Показать строку (вид модели) либо снять (`deleted`). */
  show: (stored: WireStoredMessage) => Promise<void>;
  /** Счётчики этих чатов пересчитать от маркера (пачка журнала, сдвиг маркера). */
  onChatsTouched: (addresses: string[]) => void;
  loadClearedUntil: () => Record<string, number>;
  /** Своё сообщение изменилось (правка, удаление): запись журнала исходящих — следом. */
  updateOwnJournal?: (stored: WireStoredMessage) => void;
  journal: () => HistoryJournalSink | undefined;
  /** Кэш строк прежних сборок (`m:<uuid>`, маркеры `rm:`): разово переносится в модель и стирается. */
  legacy?: {
    load: () => Promise<WireStoredMessage[]>;
    loadMarks: () => Promise<Record<string, HReadMark>>;
    drop: (uuids: string[], addresses: string[]) => Promise<void>;
  };
  log: (message: string) => void;
};

export type RowMeta = { id: string; chat: string; from: string; tsMs: number; kind: string };

function parseWire(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Строка показа web по представлению модели: содержимое — в виде web (`wire`, правка наложена движком), доставка,
 * место в ленте и время — модели. */
export function storedOfView(
  view: RawMessageView, self: string, isOwn: (address: string | undefined) => boolean,
): WireStoredMessage | undefined {
  const id = b64ToUuid(view.id);
  const chatAddress = addressForPeer(view.chat);
  if (!id || !chatAddress) return undefined;
  const {
    content: rawContent, reply_to: replyTo, proof, reactors: rawReactors, ...rest
  } = parseWire(view.wire);
  const from = view.from || '';
  const to = view.chat?.group ? chatAddress : (isOwn(from) ? chatAddress : self);
  const tsMs = Number(view.ts_ms || 0);
  const content = (rawContent && typeof rawContent === 'object' ? rawContent : { kind: 'unsupported' }) as
    WireMessageContent;
  const reactors = Array.isArray(rawReactors) ? rawReactors as WireReactor[] : [];
  const reactions = (view.reactions || []).filter((r) => r.emoji).map((r) => ({
    emoji: r.emoji!, count: Number(r.count || 0), mine: r.mine || undefined,
  }));
  return {
    ...(rest as Partial<WireStoredMessage>),
    id,
    from,
    to,
    ts: Math.floor(tsMs / MS_IN_SECOND),
    tsMs,
    content,
    reply_to: typeof replyTo === 'string' ? replyTo : undefined,
    proof: typeof proof === 'string' ? proof : undefined,
    edited: Number(view.edited_ts_ms || 0) > 0 || undefined,
    reactions: reactions.length ? reactions : undefined,
    reactors: reactors.length ? reactors : undefined,
    pinned: view.pinned || undefined,
    read: view.delivery === 'DELIVERY_READ' || undefined,
    order: Number(view.order || 0) || undefined,
    origin: 'v2',
    inModel: true,
  };
}

export function createHistoryRows(deps: Deps) {
  const chains = new Map<string, Promise<unknown>>();
  let marks = new Map<string, HReadMark>();
  let readyOwner = '';
  let ready: Promise<RowsModel | undefined> | undefined;

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

  /** Модель открыта: копия маркеров загружена, кэш прежних сборок перенесён (один раз на профиль). */
  function model(): Promise<RowsModel | undefined> {
    const self = deps.self();
    if (readyOwner !== self) {
      readyOwner = self;
      marks = new Map();
      ready = undefined;
    }
    if (!ready) {
      ready = (async () => {
        const m = await deps.model();
        if (!m) return undefined;
        await importLegacy(m).catch((e: unknown) => deps.log(`история: прежний кэш строк не перенесён: ${String(e)}`));
        await reloadMarks(m);
        return m;
      })().catch((e: unknown) => {
        deps.log(`история: модель строк недоступна: ${String(e)}`);
        return undefined;
      });
      // Модель не открылась (нет сети до первого подключения) — повтор при следующем обращении
      void ready.then((m) => {
        if (!m && readyOwner === self) ready = undefined;
      });
    }
    return ready;
  }

  async function reloadMarks(m: RowsModel) {
    const all = await m.all({ marks: true });
    const next = new Map<string, HReadMark>();
    (all.marks || []).forEach((mark) => {
      const address = addressForPeer(mark.chat);
      if (address) next.set(address, mark);
    });
    marks = next;
  }

  /** Разовый перенос кэша строк прежних сборок web (`m:`, `rm:`) в модель: сведение с известным, место прежнее. */
  async function importLegacy(m: RowsModel) {
    if (!deps.legacy) return;
    const records = await deps.legacy.load();
    const oldMarks = await deps.legacy.loadMarks();
    if (!records.length && !Object.keys(oldMarks).length) return;
    const rows = legacyRows(records);
    for (let i = 0; i < rows.length; i += APPLY_CHUNK) {
      await m.apply({ rows_json: JSON.stringify(rows.slice(i, i + APPLY_CHUNK)), now_ms: String(Date.now()) });
    }
    const markOps = Object.values(oldMarks).map((mark) => ({ read: mark }));
    if (markOps.length) await m.apply({ ops_json: JSON.stringify(markOps), now_ms: String(Date.now()) });
    await deps.legacy.drop(records.map((r) => r.id), Object.keys(oldMarks));
    deps.log(`история: прежний кэш строк перенесён в модель (строк ${rows.length}, маркеров ${markOps.length})`);
  }

  /** Строки прежнего кэша сводимым состоянием с местом в ленте (перенос T115 и разовый перенос кэша). */
  function legacyRows(records: WireStoredMessage[]) {
    const domain = deps.domain();
    const out = new Map<string, { hs: HRowState; order?: number }>();
    records.forEach((stored) => {
      if (out.has(stored.id)) return;
      const address = stored.hs ? addressForPeer(stored.hs.chat) : chatAddressOf(stored);
      const chat = address ? peerForAddress(address, domain) : undefined;
      if (!chat) return;
      const hs = stored.hs || legacyState(stored, chat);
      if (hs) out.set(stored.id, { hs, order: stored.order });
    });
    return Array.from(out.values());
  }

  /** Применить итог `rowsApply`: изменившиеся строки — на показ (снятые — надгробием). */
  async function applyOutcome(out: ModelOutcome | undefined) {
    const changed = new Map<string, WireStoredMessage>();
    const changes = ((out?.delta as { changes?: Record<string, unknown>[] } | undefined)?.changes) || [];
    const self = deps.self();
    const isOwn = ownChecker();
    for (const ch of changes) {
      const up = ch.message_upsert as RawMessageView | undefined;
      if (up) {
        const stored = storedOfView(up, self, isOwn);
        if (!stored) continue;
        if (isOwn(stored.from)) deps.updateOwnJournal?.(stored);
        deps.index.set(stored);
        changed.set(stored.id, stored);
        await deps.show(stored);
        continue;
      }
      const removed = ch.message_remove as { chat?: HPeer; id?: string } | undefined;
      if (removed) {
        const uuid = b64ToUuid(removed.id);
        if (!uuid) continue;
        const address = addressForPeer(removed.chat) || '';
        const known = deps.index.get(uuid);
        // Строка того же id в другом чате — не эта
        const prev = known && chatAddressOf(known) === address ? known : undefined;
        // Надгробие без содержимого: удалённое не остаётся и в памяти показа
        const tomb: WireStoredMessage = prev ? {
          ...prev,
          content: { kind: 'unsupported' },
          reactions: undefined,
          reactors: undefined,
          deleted: true,
          inModel: true,
        } : {
          id: uuid, from: '', to: address, ts: 0, content: { kind: 'unsupported' }, deleted: true, origin: 'v2',
          inModel: true,
        };
        changed.set(uuid, tomb);
        // Сирота (мутация раньше сообщения) не показывалась и в индекс не входит: её чат сверит модель
        if (!prev) continue;
        if (isOwn(prev.from)) deps.updateOwnJournal?.(tomb);
        deps.index.set(tomb);
        await deps.show(tomb);
      }
    }
    return changed;
  }

  function chatPeerOf(op: HOp) {
    return op.row?.chat || op.gone?.chat || op.edit?.chat || op.react?.chat || op.pin?.chat || op.state?.chat;
  }

  /** Применить операцию к строке. Возвращает строку после применения (undefined — отвергнута/без цели/без изменений
   * у неизвестной строки). */
  function ingest(op: HOp, ctx: HistoryIngestContext): Promise<WireStoredMessage | undefined> {
    const target = opTarget(op);
    if (!target) return Promise.resolve(undefined);
    return serialize(target, () => ingestUnserialized(target, op, ctx));
  }

  async function ingestUnserialized(target: string, op: HOp, ctx: HistoryIngestContext) {
    const isOwn = ownChecker();
    const prev = await deps.index.find(target);
    const chat = chatPeerOf(op);
    let base: { hs: HRowState; order?: number } | undefined;
    // Известная строка — чат сверяется по ней самой: иначе участник общей группы личным сообщением удалял, закреплял и
    // менял реакции сообщений группы (C7-2), а строка того же id в другом чате заслонила бы её показ
    const prevAddress = prev ? chatAddressOf(prev) : undefined;
    if (prevAddress && chat && addressForPeer(chat) !== prevAddress) {
      deps.log(`история: операция над ${target} из другого чата — пропуск`);
      return undefined;
    }
    if (prev && prevAddress && !prev.inModel) {
      if (!prev.deleted && !isJournalable(prev)) {
        // Самоуничтожение: мутация — прямо по строке в памяти, как раньше
        if (ctx.source === 'journal' || !isAllowedOutsideJournal(op, prev, prevAddress, ctx)) return undefined;
        const patched = patchOutsideJournal(prev, op, isOwn);
        if (!patched) return undefined;
        deps.index.set(patched);
        await deps.show(patched);
        return patched;
      }
      // Своё из журнала исходящих, ещё не строка модели: строка — вместе с операцией
      const prevChat = peerForAddress(prevAddress, deps.domain());
      const hs = prevChat && !prev.deleted ? legacyState(prev, prevChat) : undefined;
      if (hs) base = { hs, order: prev.order };
    }
    const m = await model();
    if (!m) {
      deps.log(`история: модель не открыта — операция над ${target} не применена`);
      return undefined;
    }
    const out = await m.apply({
      ops_json: JSON.stringify([op]),
      rows_json: base ? JSON.stringify([base]) : undefined,
      now_ms: String(Date.now()),
    });
    const changed = await applyOutcome(out);
    const stored = changed.get(target);
    if (!stored) return prev?.inModel ? prev : undefined;
    const isJournaled = op.row ? !stored.deleted && isJournalable(stored) : true;
    if (ctx.source !== 'journal' && isJournaled) {
      deps.journal()?.enqueue(op, { isOwn: ctx.source === 'own' });
    }
    return stored;
  }

  /** Строка вне журнала истории (заглушка нечитаемого вида, служебное о режиме L2, своё самоуничтожение) — строкой
   * модели без записи в журнал; самоуничтожение собеседника и шифртекст v1 — только показ. */
  async function persistLocal(stored: WireStoredMessage) {
    const { kind } = stored.content;
    const isOwn = ownChecker();
    const isPeerTtl = Boolean(stored.content.ttl_secs) && !isOwn(stored.from);
    if (kind === 'encrypted' || kind === 'group_encrypted' || isPeerTtl || stored.deleted || !stored.from) {
      deps.index.set(stored);
      await deps.show(stored);
      return stored;
    }
    const chat = peerForAddress(chatAddressOf(stored), deps.domain());
    const m = chat ? await model() : undefined;
    let op: HOp | undefined;
    try {
      op = chat ? rowOpFromStored(stored, chat, stored.tsMs) : undefined;
    } catch (e) {
      deps.log(`история: строка ${stored.id} — вне модели (${String(e)})`);
    }
    if (!m || !op) {
      deps.index.set(stored);
      await deps.show(stored);
      return stored;
    }
    const changed = await applyOutcome(await m.apply({ ops_json: JSON.stringify([op]), now_ms: String(Date.now()) }));
    return changed.get(stored.id) || deps.index.get(stored.id) || stored;
  }

  /** Много строк вне журнала сразу, без показа (диагностика: замер окна истории). */
  async function persistMany(list: WireStoredMessage[]) {
    const m = await model();
    if (!m) return 0;
    const domain = deps.domain();
    const ops = list.flatMap((stored) => {
      const chat = peerForAddress(chatAddressOf(stored), domain);
      return chat ? [rowOpFromStored(stored, chat, stored.tsMs)] : [];
    });
    for (let i = 0; i < ops.length; i += APPLY_CHUNK) {
      await m.apply({ ops_json: JSON.stringify(ops.slice(i, i + APPLY_CHUNK)), now_ms: String(Date.now()) });
    }
    return ops.length;
  }

  /** Квитанция «прочитано» на своё исходящее (✓✓): доставка строки в модели. */
  async function receipt(address: string, uuid: string) {
    const chat = peerForAddress(address, deps.domain());
    const m = chat ? await model() : undefined;
    if (!m || !chat) return undefined;
    const changed = await applyOutcome(await m.apply({ receipts_json: JSON.stringify([{ chat, target: uuid }]) }));
    return changed.get(uuid);
  }

  /** Убрать строки у себя без надгробия (очистка истории, самоуничтожение, удаление чата). */
  async function forget(uuids: string[]) {
    const domain = deps.domain();
    const targets = uuids.flatMap((uuid) => {
      const known = deps.index.get(uuid);
      if (known) deps.index.remove(uuid);
      const chat = known ? peerForAddress(chatAddressOf(known), domain) : undefined;
      return chat && known?.inModel ? [{ chat, target: uuid }] : [];
    });
    const m = targets.length ? await model() : undefined;
    if (!m) return;
    for (let i = 0; i < targets.length; i += APPLY_CHUNK) {
      await m.apply({ forget_json: JSON.stringify(targets.slice(i, i + APPLY_CHUNK)) });
    }
  }

  /** Пачка операций журнала (или точки): строки — в модель и на экран, маркеры — сведением; счётчики чатов пачки
   * пересчитываются от маркеров один раз в конце (перенос не прибавляет к непрочитанному, FR-013). */
  async function applyJournalOps(ops: HOp[]) {
    const m = await model();
    if (!m) return 0;
    const touched = new Set<string>();
    const list = ops.filter((op) => !op.summary);
    const readChats = list.map((op) => addressForPeer(op.read?.chat)).filter((a): a is string => Boolean(a));
    const before = new Map(readChats.map((a) => [a, JSON.stringify(marks.get(a))]));
    for (let i = 0; i < list.length; i += APPLY_CHUNK) {
      const changed = await applyOutcome(await m.apply({
        ops_json: JSON.stringify(list.slice(i, i + APPLY_CHUNK)), now_ms: String(Date.now()),
      }));
      changed.forEach((stored) => {
        const address = stored.inModel ? chatAddressOf(stored) : undefined;
        if (address) touched.add(address);
      });
    }
    if (readChats.length) {
      await reloadMarks(m);
      before.forEach((was, address) => {
        if (JSON.stringify(marks.get(address)) !== was) touched.add(address);
      });
    }
    if (touched.size) deps.onChatsTouched(Array.from(touched));
    return touched.size;
  }

  // ── маркеры «прочитано до» ────────────────────────────────────────────────

  async function ensureMarks() {
    await model();
  }

  function getMark(address: string) {
    return marks.get(address);
  }

  async function applyMark(mark: HReadMark, source: HistorySource) {
    const address = addressForPeer(mark.chat);
    if (!address) return false;
    const m = await model();
    if (!m) return false;
    const old = JSON.stringify(marks.get(address));
    try {
      await m.apply({ ops_json: JSON.stringify([{ read: mark }]), now_ms: String(Date.now()) });
    } catch (e) {
      deps.log(`история: маркер ${address} не принят: ${String(e)}`);
      return false;
    }
    await reloadMarks(m);
    const merged = marks.get(address);
    if (!merged || JSON.stringify(merged) === old) return false;
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

  // ── чтение модели ─────────────────────────────────────────────────────────

  /** Все строки модели в виде показа web — и служебные строки ленты (голоса опросов); `known` — id всех строк
   * модели, и надгробий. */
  async function loadStored(): Promise<{ rows: WireStoredMessage[]; known: Set<string>; isReady: boolean }> {
    const m = await model();
    if (!m) return { rows: [], known: new Set(), isReady: false };
    const self = deps.self();
    const isOwn = ownChecker();
    const all = await m.all({ views: true, states: true });
    const rows = (all.views || []).map((v) => storedOfView(v, self, isOwn))
      .filter((s): s is WireStoredMessage => Boolean(s));
    return { rows, known: new Set((all.states || []).map((st) => st.target)), isReady: true };
  }

  /** Страница ленты чата модели (`historyPage`): строки по возрастанию места. */
  async function page(address: string, opts: {
    anchor?: { order: number; id?: string }; direction: 'older' | 'newer' | 'around'; limit: number;
  }) {
    const chat = peerForAddress(address, deps.domain());
    const m = chat ? await model() : undefined;
    if (!m || !chat) return undefined;
    const direction = opts.direction === 'newer' ? 'PAGE_DIRECTION_NEWER'
      : opts.direction === 'around' ? 'PAGE_DIRECTION_AROUND' : 'PAGE_DIRECTION_OLDER';
    const anchor = opts.anchor ? {
      ts_ms: String(opts.anchor.order),
      id: opts.anchor.id ? uuidToB64(opts.anchor.id) : MIN_ID_B64,
    } : undefined;
    const p = await m.view('historyPage', {
      chat, anchor, direction, limit: Math.min(PAGE_MAX, Math.max(1, opts.limit)),
    }) as { rows?: RawMessageView[]; has_older?: boolean; has_newer?: boolean };
    const self = deps.self();
    const isOwn = ownChecker();
    return {
      rows: (p.rows || []).map((v) => storedOfView(v, self, isOwn)).filter((s): s is WireStoredMessage => Boolean(s)),
      hasOlder: Boolean(p.has_older),
      hasNewer: Boolean(p.has_newer),
    };
  }

  /** Чаты, у которых в модели есть показываемые строки (`chatList`): адрес и последняя строка. */
  async function chatsWithRows() {
    const m = await model();
    if (!m) return undefined;
    const out: { address: string; last?: string }[] = [];
    let after: unknown;
    for (let i = 0; i < 1000; i++) {
      const p = await m.view('chatList', { after, limit: PAGE_MAX }) as {
        chats?: { chat?: HPeer; last?: RawMessageView }[]; next?: unknown;
      };
      (p.chats || []).forEach((c) => {
        const address = addressForPeer(c.chat);
        if (address) out.push({ address, last: b64ToUuid(c.last?.id) });
      });
      if (!p.next) break;
      after = p.next;
    }
    return out;
  }

  // ── состояния для контрольной точки и переноса ────────────────────────────

  /** Все строки журнала как `RowState` (и надгробия, сироты); без очищенных чатов и строк вне журнала. */
  async function collectStates(): Promise<HRowState[]> {
    const m = await model();
    if (!m) return [];
    const all = await m.all({ states: true });
    const cleared = deps.loadClearedUntil();
    return (all.states || []).filter((state) => {
      const address = addressForPeer(state.chat);
      if (!address) return false;
      const body = decodeBody(state.row?.body);
      const content = body?.content as { kind?: string; ttl_secs?: number } | undefined;
      // Надгробия и сироты — всегда (удалённое не воскресает на других устройствах); живая строка — если журналу
      if (state.row && !state.gone && (!content?.kind || content.ttl_secs || UNJOURNALED_KINDS.has(content.kind))) {
        return false;
      }
      const tsMs = Number(state.row?.ts_ms || 0);
      return !(tsMs && tsMs <= (cleared[address] || 0));
    });
  }

  /** Строки прежнего кэша web (`m:`) сводимым состоянием — для разового переноса (T115), до него модель их не знает. */
  async function legacyStates(): Promise<{ hs: HRowState; order?: number }[]> {
    const records = await deps.legacy?.load() || [];
    const cleared = deps.loadClearedUntil();
    return legacyRows(records).filter(({ hs }) => {
      const address = addressForPeer(hs.chat);
      const tsMs = Number(hs.row?.ts_ms || 0);
      if (!address) return false;
      return !(tsMs && tsMs <= (cleared[address] || 0));
    });
  }

  function chatAddressOf(stored: WireStoredMessage) {
    const isOwn = ownChecker();
    if (stored.to.startsWith(V2_GROUP_ADDRESS_PREFIX)) return stored.to;
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

  /** Маркеры по прежнему учёту прочитанного (перенос spec 033, FR-024): по чату — самая поздняя прочитанная входящая
   * и самое позднее своё сообщение. */
  async function legacyMarks(readUuids: Set<string>) {
    const records = (await loadStored()).rows;
    const isOwnAddress = ownChecker();
    const best = new Map<string, { tsMs: number; id: string }>();
    records.forEach((stored) => {
      if (stored.deleted || !stored.from || !isJournalable(stored)) return;
      const isOwn = isOwnAddress(stored.from);
      if (!isOwn && !readUuids.has(stored.id)) return;
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

  /** Замена истории точкой (устройство дольше горизонта надгробий без синхронизации): строки и маркеры модели
   * стираются, показ — заново из точки. */
  async function wipe() {
    const m = await model();
    if (!m) return [];
    const all = await m.all({ states: true });
    const uuids = (all.states || []).map((s) => s.target);
    await applyOutcome(await m.apply({ wipe: true }));
    uuids.forEach((uuid) => deps.index.remove(uuid));
    marks = new Map();
    return uuids;
  }

  function reset() {
    chains.clear();
    marks = new Map();
    ready = undefined;
    readyOwner = '';
  }

  return {
    ingest,
    persistLocal,
    receipt,
    forget,
    applyJournalOps,
    applyMark,
    advanceMark,
    ensureMarks,
    getMark,
    marksList: () => Array.from(marks.values()),
    persistMany,
    isUnread,
    ownAddresses,
    loadStored,
    page,
    chatsWithRows,
    collectStates,
    legacyStates,
    summarizeChats,
    legacyMarks,
    wipe,
    reset,
  };
}

export type HistoryRows = ReturnType<typeof createHistoryRows>;

// Виды вне журнала истории: шифртекст прежних версий и заглушки нечитаемых видов
const UNJOURNALED_KINDS = new Set(['encrypted', 'group_encrypted', 'unsupported']);
// Якорь страницы по одному месту (id строки не известен): меньше любого id того же места
const MIN_ID_B64 = btoa(String.fromCharCode(...new Array<number>(16).fill(0)));

// Строка вне журнала (самоуничтожение) движком не сводится — то же правило прав здесь: правка — только автор,
// удаление — `historyCanDelete` (вид чата — по адресу самой строки `prevAddress`, не по операции: C7-2)
function isAllowedOutsideJournal(
  op: HOp, prev: WireStoredMessage, prevAddress: string, ctx: HistoryIngestContext,
) {
  if (ctx.source === 'own' || !ctx.author) return true;
  if (op.edit) return prev.from === ctx.author;
  if (!op.gone) return true;
  const isGroup = prevAddress.startsWith(V2_GROUP_ADDRESS_PREFIX);
  return canDelete(isGroup ? 'group' : 'user', prev.from, ctx.author, ctx.isAdmin);
}

// Мутация строки вне журнала (самоуничтожение): поля строки напрямую, без сведения
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
    if (emoji) reactors.push({ user, emoji, ts: Math.floor(Number(op.react.stamp.ts_ms) / MS_IN_SECOND) });
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
