// Строки истории (spec 033 HIST-1, READ-2; spec 035 T114): строками владеет модель движка (`rowsApply`/`rowsAll`,
// `historyPage`, `chatList` в режиме хоста). Каждое событие истории — приём, отправка, действие пользователя, запись
// журнала, квитанция, очистка — уходит модели операцией; сведение (`RowState`, надгробия, сироты), место в ленте
// (ORDER-1), маркеры «прочитано до» и хранение — в модели, показ — из её представлений (`MessageView` с содержимым
// в виде web, `wire`). Своей копии строк у web нет; в памяти — только индекс показанного (`MessageIndex`) и копия
// маркеров для подсчёта непрочитанного. Журнал истории аккаунта (очередь пачкой, догон, контрольные точки, замена
// дальше горизонта) ведёт модель (spec 036, `engine_rows`): свои операции уходят ей с `journal: true`, входящее она
// применяет сама; своего журнала у web нет.
//
// Вне модели — только строки самоуничтожения собеседника (в памяти показа, в журнал не попадают и не переживают
// перезагрузку — так задумано: самоуничтожение не должно оставлять следов на диске) и шифртекст v1.

import type { MessageIndex } from './v2/messageIndex';
import type { WireMessageContent, WireReactor, WireStoredMessage } from './wire';

import { b64ToUuid, uuidToB64 } from './v2/contentMap';
import {
  addressForPeer, canDelete, decodeBody, type EditPatch, historyChatKey, type HOp, type HPeer, type HReadMark,
  type HRowState, isJournalable, legacyState, opTarget, peerForAddress,
  rowOpFromStored,
} from './v2/historyModel';

const V2_GROUP_ADDRESS_PREFIX = 'v2g:';
const MS_IN_SECOND = 1000;
// Операций в одном вызове модели (граница — 4 МБ JSON)
const APPLY_CHUNK = 200;
const PAGE_MAX = 200;

export type HistorySource = 'own' | 'inbox';

export type HistoryIngestContext = {
  source: HistorySource;
  // Автор мутации (для проверки прав по известной строке) и его право удалять чужое в группе
  author?: string;
  isAdmin?: boolean;
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

/** Вид чата модели (`chatList`, spec 036 E3). */
type RawChatView = {
  chat?: HPeer; last?: RawMessageView; unread?: number; mention?: boolean; pinned_rank?: number;
  archived?: boolean; unread_mark?: boolean;
};

/** Чат списка модели для показа. */
export type ModelChat = {
  address: string; last?: string; unread: number; mention: boolean; pinnedRank: number; archived: boolean;
  unreadMark: boolean;
  /** Последняя показываемая строка чата в виде показа (ленивый показ истории, spec 036 T015). */
  lastStored?: WireStoredMessage;
};

/** Счётчик непрочитанного модели (`unread_changed`): маркер и упоминания. */
export type ModelUnread = { count: number; lastReadId?: string; mentions: string[] };

/** Строки модели профиля (хост модели `ModelHost`). */
export type RowsModel = {
  /** `rowsApply` — итог (`Outcome`) с изменениями показа. */
  apply: (args: Record<string, unknown>) => Promise<ModelOutcome>;
  /** `rowsAll`; `chat_key` — только строки этого чата (ключ `historyChatKey`). */
  all: (what: { views?: boolean; states?: boolean; marks?: boolean; chat_key?: string }) => Promise<RowsAll>;
  /** `historyPage` / `chatList` модели. */
  view: (name: 'historyPage' | 'chatList', args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Намерение модели (`submit`, spec 036): прочтение и прочее. */
  submit?: (intent: Record<string, unknown>) => Promise<ModelOutcome>;
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
  /** Строки списка чатов, изменённые моделью (`chat_upsert`), и снятые из списка (`chat_remove`, адреса). Зовётся
   * вне обработчика изменений модели. */
  onChatViews?: (upserts: ModelChat[], removed: string[]) => void;
  /** Своё сообщение изменилось (правка, удаление): запись журнала исходящих — следом. */
  updateOwnJournal?: (stored: WireStoredMessage) => void;
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

/** Строка списка чатов модели (`ChatView`) для показа. */
function modelChatOf(
  c: RawChatView, self: string, isOwn: (address: string | undefined) => boolean,
): ModelChat | undefined {
  const address = addressForPeer(c.chat);
  if (!address) return undefined;
  return {
    address,
    last: b64ToUuid(c.last?.id),
    unread: Number(c.unread || 0),
    mention: Boolean(c.mention),
    pinnedRank: Number(c.pinned_rank || 0),
    archived: Boolean(c.archived),
    unreadMark: Boolean(c.unread_mark),
    lastStored: c.last ? storedOfView(c.last, self, isOwn) : undefined,
  };
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
  // Счётчики непрочитанного модели (`unread_changed`, spec 036): маркер, число, упоминания — готовыми
  const modelUnread = new Map<string, ModelUnread>();
  let unreadableTotal = 0;
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

  /** Модель профиля открыта (один раз на профиль). */
  function model(): Promise<RowsModel | undefined> {
    const self = deps.self();
    if (readyOwner !== self) {
      readyOwner = self;
      ready = undefined;
    }
    if (!ready) {
      ready = deps.model().catch((e: unknown) => {
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
        // Строка не показана (сирота — мутация раньше сообщения; строка ещё не прочитанного целиком чата, spec 036
        // T015): в индекс не входит, но показ узнаёт о снятии — идущее чтение чата из модели её не вернёт
        if (!prev) {
          await deps.show(tomb);
          continue;
        }
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
        // Самоуничтожение собеседника: мутация — прямо по строке в памяти, мимо модели и журнала
        if (!isAllowedOutsideJournal(op, prev, prevAddress, ctx)) return undefined;
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
    // Журнал истории — у модели (`journal: true`): она ставит операцию в свою пачку, если та изменила строку
    const out = await m.apply({
      ops_json: JSON.stringify([op]),
      rows_json: base ? JSON.stringify([base]) : undefined,
      now_ms: String(Date.now()),
      journal: true,
    });
    const changed = await applyOutcome(out);
    const stored = changed.get(target);
    if (!stored) return prev?.inModel ? prev : undefined;
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

  // ── маркеры «прочитано до» ────────────────────────────────────────────────
  // Маркеры, их сведение и счётчик непрочитанного — у модели (spec 036 T014): web шлёт сдвиг маркера (`read` либо
  // намерение) и получает готовое `unread_changed` (число, маркер, упоминания); своей копии маркеров у web нет

  /** Модель открыта: непрочитанное придёт её изменениями. */
  async function ensureMarks() {
    await model();
  }

  async function applyMark(mark: HReadMark) {
    const address = addressForPeer(mark.chat);
    if (!address) return false;
    const m = await model();
    if (!m) return false;
    try {
      // Маркер — в журнал истории моделью (той же пачкой, что всё остальное, S7-3)
      await m.apply({ ops_json: JSON.stringify([{ read: mark }]), now_ms: String(Date.now()), journal: true });
    } catch (e) {
      deps.log(`история: маркер ${address} не принят: ${String(e)}`);
      return false;
    }
    return true;
  }

  /** Сдвинуть маркер чата до строки (прочтение, своё отправленное, копия своей квитанции). */
  async function advanceMark(address: string, tsMs: number, id: string) {
    const chat = peerForAddress(address, deps.domain());
    if (!chat || !id) return false;
    return applyMark({ chat, up_to_ts_ms: String(Math.floor(tsMs)), up_to_id: id.toLowerCase() });
  }

  /** Прочтение намерением модели (spec 036 E4, `engine_rows`): маркер, квитанции собеседнику о ставших прочитанными
   * входящих и счётчик чата — у модели. `false` — модель недоступна или строки в ней нет (прежний путь). */
  async function readTo(address: string, tsMs: number, id: string) {
    const chat = peerForAddress(address, deps.domain());
    const m = await model();
    if (!chat || !m?.submit) return false;
    try {
      await m.submit({ read: { chat, up_to: { ts_ms: String(Math.floor(tsMs)), id: uuidToB64(id) } } });
    } catch (e) {
      deps.log(`история: прочтение ${address} моделью не принято: ${String(e)}`);
      return false;
    }
    return true;
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

  /** Строки одного чата модели (ленивый показ, spec 036 T015) — и служебные строки ленты (голоса опросов); `known` —
   * id всех строк чата, и надгробий. */
  async function loadChat(address: string) {
    const chat = peerForAddress(address, deps.domain());
    const m = chat ? await model() : undefined;
    if (!m || !chat) return undefined;
    const self = deps.self();
    const isOwn = ownChecker();
    const all = await m.all({ views: true, states: true, chat_key: historyChatKey(chat) });
    const rows = (all.views || []).map((v) => storedOfView(v, self, isOwn))
      .filter((s): s is WireStoredMessage => Boolean(s));
    return { rows, known: new Set((all.states || []).map((st) => st.target)) };
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

  /** Непрочитанное чата по модели (spec 036 E4); нет — изменения ещё не приходило. */
  function unreadOf(address: string) {
    return modelUnread.get(address);
  }

  /** Чаты списка модели (`chatList`): адрес, последняя строка (и в виде показа), счётчики, архив, закреп. */
  async function chatsWithRows() {
    const m = await model();
    if (!m) return undefined;
    const self = deps.self();
    const isOwn = ownChecker();
    const out: ModelChat[] = [];
    let after: unknown;
    for (let i = 0; i < 1000; i++) {
      const p = await m.view('chatList', { after, limit: PAGE_MAX }) as {
        chats?: RawChatView[]; next?: unknown;
      };
      (p.chats || []).forEach((c) => {
        const chat = modelChatOf(c, self, isOwn);
        if (!chat) return;
        out.push(chat);
        // Счётчик до первого `unread_changed` этого чата — из вида списка
        if (!modelUnread.has(chat.address)) modelUnread.set(chat.address, { count: chat.unread, mentions: [] });
      });
      if (!p.next) break;
      after = p.next;
    }
    return out;
  }

  function chatAddressOf(stored: WireStoredMessage) {
    const isOwn = ownChecker();
    if (stored.to.startsWith(V2_GROUP_ADDRESS_PREFIX)) return stored.to;
    if (stored.from && !isOwn(stored.from)) return stored.from;
    return stored.to;
  }

  /** spec 036 (`engine_rows`): изменения строк, которые модель сделала сама (входящее, журнал истории), — на
   * показ; маркеры перечитываются, когда модель сменила счётчик чата. */
  async function applyModelDelta(delta: Record<string, unknown>) {
    const changes = (delta.changes as Record<string, unknown>[] | undefined) || [];
    noteUnreadable(changes);
    const rows = changes.some((ch) => ch.message_upsert || ch.message_remove);
    // spec 036 T018: строки списка чатов — готовыми видами модели; показ — вне обработчика (ниже)
    const self = deps.self();
    const isOwn = ownChecker();
    const chatUpserts = changes.flatMap((ch) => {
      const chat = ch.chat_upsert ? modelChatOf(ch.chat_upsert, self, isOwn) : undefined;
      return chat ? [chat] : [];
    });
    const chatRemoves = changes.map((ch) => addressForPeer(ch.chat_remove as HPeer | undefined))
      .filter((a): a is string => Boolean(a));
    if ((chatUpserts.length || chatRemoves.length) && deps.onChatViews) {
      setTimeout(() => deps.onChatViews?.(chatUpserts, chatRemoves), 0);
    }
    const unread = changes.filter((ch) => ch.unread_changed);
    unread.forEach((ch) => {
      const u = ch.unread_changed as { chat?: HPeer; count?: number; last_read_id?: string; mentions?: string[] };
      const address = addressForPeer(u.chat);
      if (!address) return;
      modelUnread.set(address, {
        count: Number(u.count || 0),
        lastReadId: b64ToUuid(u.last_read_id),
        mentions: (u.mentions || []).map((x) => b64ToUuid(x)).filter((x): x is string => Boolean(x)),
      });
    });
    if (!rows && !unread.length) return;
    const touched = new Set(unread.map((ch) => addressForPeer((ch.unread_changed as { chat?: HPeer }).chat))
      .filter((a): a is string => Boolean(a)));
    if (rows) {
      const upserts = changes.filter((ch) => ch.message_upsert).length;
      const removes = changes.filter((ch) => ch.message_remove).length;
      deps.log(`история: модель — строк ${upserts}, снято ${removes}`);
      // Строки, применённые моделью (входящее, журнал истории): чат объявляется и пересчитывается, как у
      // `applyJournalOps` — иначе история нового устройства лежала в модели, а чата в списке не было
      (await applyOutcome({ delta })).forEach((stored) => {
        const address = stored.inModel ? chatAddressOf(stored) : undefined;
        if (address) touched.add(address);
      });
    }
    if (!touched.size) return;
    // Вне обработчика изменений: изменение приходит и при открытии модели, а `model()` ждёт конца открытия —
    // ожидание здесь замыкало открытие само на себя (вкладка после перезагрузки висела без списка чатов)
    setTimeout(() => deps.onChatsTouched(Array.from(touched)), 0);
  }

  // Записи журнала истории, которые не открылись ни текущим, ни прежними ключами (нотис модели
  // `history_unreadable`): раньше пропускались молча — теперь счётчик в журнале диагностики
  function noteUnreadable(changes: Record<string, unknown>[]) {
    changes.forEach((ch) => {
      const notice = ch.notice as { kind?: string; detail?: string } | undefined;
      if (notice?.kind !== 'history_unreadable') return;
      unreadableTotal += Number(notice.detail) || 0;
      deps.log(`история: не открыто ключом записей — ${notice.detail}, всего ${unreadableTotal}`);
    });
  }

  function reset() {
    unreadableTotal = 0;
    chains.clear();
    modelUnread.clear();
    ready = undefined;
    readyOwner = '';
  }

  return {
    ingest,
    applyModelDelta,
    persistLocal,
    receipt,
    forget,
    advanceMark,
    ensureMarks,
    persistMany,
    readTo,
    ownAddresses,
    loadStored,
    loadChat,
    page,
    chatsWithRows,
    unreadOf,
    reset,
  };
}

export type HistoryRows = ReturnType<typeof createHistoryRows>;

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
      : patchMemoryContent(prev.content, body.edit_patch || {});
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

// Правка строки в памяти показа: модель таких строк не знает (самоуничтожение собеседника — память хоста, HIST-1
// п. 6), поэтому заплатку накладывает хост — по тому же правилу, что модель (`views::effective_content`)
function patchMemoryContent(content: WireMessageContent, patch: EditPatch): WireMessageContent {
  const next = { ...content };
  if (patch.text !== undefined) {
    Object.assign(next, next.kind === 'text'
      ? { text: patch.text, entities: patch.entities, webpage: patch.webpage }
      : { caption: patch.text, entities: patch.entities });
  }
  if (patch.fields) Object.assign(next, patch.fields);
  return next;
}
