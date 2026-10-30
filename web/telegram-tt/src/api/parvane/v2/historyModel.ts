// Журнал истории аккаунта (spec 033, HIST-1/HIST-2/READ-2): модель строки сообщения на стороне web.
// Сведение (`RowState`), вид строки, маркер прочтения и права удаления считает движок (статические функции
// `history*`, `specs/033-history-sync/contracts/engine-api.md`); здесь — перекладка между строкой кэша web
// (`WireStoredMessage`) и JSON движка. Своего сведения клиент не делает.

import type { WireMessageContent, WireReactor, WireStoredMessage } from '../wire';

import { base64ToBytes, bytesToBase64 } from './base64';
import { historyStatic } from './engine';

// proto3-JSON `parvane.history.v1.*` (имена полей схемы; id сообщений — UUID с дефисами; int64 — строки)
export type HPeer = { user?: { address: string }; group?: { domain: string; id: string } };
export type HStamp = { ts_ms: string | number; op_id: string };
export type HGoneScope = 'GONE_SCOPE_EVERYONE' | 'GONE_SCOPE_ME';
export type HMessageRow = { id: string; chat: HPeer; from: string; ts_ms: string | number; body?: string };
// `by` — автор мутации (пусто — своё/записи до появления поля), `by_admin` — удалил админ группы с правом. Движок
// сверяет их с автором строки: недействительная мутация не применяется ни в каком порядке событий
export type HGone = { target: string; chat: HPeer; stamp: HStamp; scope: HGoneScope; by?: string; by_admin?: boolean };
export type HEdit = { target: string; chat: HPeer; stamp: HStamp; body?: string; by?: string };
export type HReact = { target: string; chat: HPeer; user: string; stamp: HStamp; emoji?: string };
export type HPin = { target: string; chat: HPeer; stamp: HStamp; pinned?: boolean };
export type HReadMark = { chat: HPeer; up_to_ts_ms: string | number; up_to_id: string };
export type HRowState = {
  target: string;
  chat: HPeer;
  row?: HMessageRow;
  edit_stamp?: HStamp;
  edit_body?: string;
  reacts?: { user: string; stamp: HStamp; emoji?: string }[];
  pin_stamp?: HStamp;
  pinned?: boolean;
  gone?: HGone;
  // Сирота: правки и удаления — кандидатами до прихода строки (победителя выбирает движок по её автору)
  pending_edits?: HEdit[];
  pending_gones?: HGone[];
};
export type HSegmentRef = { key: string; digest?: string; seq: string | number };
export type HChatSummary = { chat: HPeer; last?: HRowState; mark?: HReadMark; unread?: number; rows?: number };
export type HSummary = { tombstones_since_ms?: string | number; chats?: HChatSummary[]; segments?: HSegmentRef[] };
export type HOp = {
  row?: HMessageRow;
  gone?: HGone;
  edit?: HEdit;
  react?: HReact;
  pin?: HPin;
  read?: HReadMark;
  state?: HRowState;
  summary?: HSummary;
};
export type HView = {
  visible: boolean;
  deleted: boolean;
  deletedScope?: 'everyone' | 'me';
  orphan: boolean;
  id: string;
  chat: HPeer;
  chatKey: string;
  from?: string;
  tsMs?: number;
  body?: Record<string, unknown>;
  edited: boolean;
  editTsMs?: number;
  reactions: { emoji: string; count: number; users: string[] }[];
  pinned: boolean;
};

// Строка web, которую нельзя сводить журналом: самоуничтожение не пишется (как и раньше в экспорт), шифртекст
// прежних версий и заглушки нечитаемых видов — тоже
export function isJournalable(stored: WireStoredMessage) {
  const { kind } = stored.content || {};
  if (!kind || stored.content.ttl_secs) return false;
  return kind !== 'encrypted' && kind !== 'group_encrypted' && kind !== 'unsupported';
}

const V2_GROUP_PREFIX = 'v2g:';
const GROUP_HEX_LENGTH = 32;
const MS_IN_SECOND = 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Собеседник журнала по адресу чата web: личный — адрес, группа v2 — `v2g:<hex>` на домене сервера. */
export function peerForAddress(address: string, domain: string): HPeer | undefined {
  if (address.includes('@')) return { user: { address } };
  if (!address.startsWith(V2_GROUP_PREFIX)) return undefined;
  const hex = address.slice(V2_GROUP_PREFIX.length);
  if (hex.length !== GROUP_HEX_LENGTH || !/^[0-9a-f]+$/.test(hex) || !domain) return undefined;
  return { group: { domain, id: hexToB64(hex) } };
}

/** Ключ чата истории (движок `historyChatKey`): личный — `u:<адрес>`, группа — `g:<hex>` без домена. */
export function historyChatKey(peer: HPeer): string {
  return historyStatic<string>('historyChatKey', { chat: peer });
}

export function addressForPeer(peer: HPeer | undefined): string | undefined {
  if (peer?.user?.address) return peer.user.address;
  if (peer?.group?.id) return `${V2_GROUP_PREFIX}${b64ToHex(peer.group.id)}`;
  return undefined;
}

export function isGroupPeer(peer: HPeer | undefined) {
  return Boolean(peer?.group);
}

/** Тело правки/строки: base64 JSON-объекта. */
export function encodeBody(value: Record<string, unknown>) {
  return bytesToBase64(encoder.encode(JSON.stringify(value)));
}

export function decodeBody(b64: string | undefined): Record<string, unknown> | undefined {
  if (!b64) return undefined;
  try {
    const value = JSON.parse(decoder.decode(base64ToBytes(b64))) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Операция `row` из строки web; `tsMs` — точное время события движка (иначе секунды строки). */
export function rowOpFromStored(stored: WireStoredMessage, chat: HPeer, tsMs?: number): HOp {
  const row: Record<string, unknown> = {
    id: stored.id,
    from: stored.from,
    ts: (tsMs ?? stored.ts * MS_IN_SECOND) / MS_IN_SECOND,
    content: stored.content,
  };
  if (stored.reply_to) row.reply_to = stored.reply_to;
  if (stored.proof) row.proof = stored.proof;
  return historyStatic<HOp>('historyRowFromWire', { row, chat });
}

export function applyOp(state: HRowState | undefined, op: HOp): HRowState {
  return historyStatic<HRowState>('historyApply', state ? { state, op } : { op });
}

export function mergeStates(a: HRowState, b: HRowState): HRowState {
  return historyStatic<HRowState>('historyMerge', { a, b });
}

export function viewOf(state: HRowState): HView {
  return historyStatic<HView>('historyView', { state });
}

export function newStamp(tsMs?: number): HStamp {
  return historyStatic<HStamp>('historyNewStamp', tsMs === undefined ? {} : { tsMs });
}

export function markMerge(a: HReadMark | undefined, b: HReadMark | undefined): HReadMark | undefined {
  return historyStatic<HReadMark | null>('historyMarkMerge', { a, b }) || undefined;
}

/** `deleter` — адрес удаляющего либо набор его адресов (текущий и прежние). */
export function canDelete(
  chatKind: 'user' | 'group', author: string, deleter: string | string[], deleterIsAdmin?: boolean,
) {
  return historyStatic<boolean>('historyCanDelete', {
    chatKind, author, deleter, deleterIsAdmin: deleterIsAdmin || undefined,
  });
}

let unreadKindsCache: Set<string> | undefined;

/** Виды содержимого, которые не считаются непрочитанными (движок). */
export function nonCountedKinds(): Set<string> {
  if (!unreadKindsCache) unreadKindsCache = new Set(historyStatic<string[]>('historyUnreadKinds'));
  return unreadKindsCache;
}

/** Цель операции (сообщение). Маркер и сводка цели не имеют. */
export function opTarget(op: HOp): string | undefined {
  return op.row?.id || op.gone?.target || op.edit?.target || op.react?.target || op.pin?.target || op.state?.target;
}

/** Ключ «эта операция уже есть в журнале»: id сообщения у строки, метка у мутаций. */
export function opKey(op: HOp): string | undefined {
  if (op.row) return `r:${op.row.id}`;
  const stamp = op.gone?.stamp || op.edit?.stamp || op.react?.stamp || op.pin?.stamp;
  return stamp ? `m:${stamp.op_id}` : undefined;
}

/** Порядок (время, id) — как в движке: сначала время, затем байты id (строки UUID в нижнем регистре сравниваются
 * так же). */
export function compareMarkPoint(tsA: number, idA: string, tsB: number, idB: string) {
  if (tsA !== tsB) return tsA < tsB ? -1 : 1;
  if (idA === idB) return 0;
  return idA < idB ? -1 : 1;
}

/** Строка (время, id) строго после маркера. */
export function isAfterMark(mark: HReadMark | undefined, tsMs: number, id: string) {
  if (!mark) return true;
  return compareMarkPoint(tsMs, id.toLowerCase(), Number(mark.up_to_ts_ms), mark.up_to_id.toLowerCase()) > 0;
}

/** Решение движка «непрочитано» по минимальной строке (движок читает только автора, время, id и вид). `self` —
 * свой адрес либо набор своих адресов (текущий и прежние после смены ника). */
export function isUnreadRow(
  meta: { id: string; chat: HPeer; from: string; tsMs: number; kind: string }, mark: HReadMark | undefined,
  self: string | string[],
) {
  const state: HRowState = {
    target: meta.id,
    chat: meta.chat,
    row: {
      id: meta.id,
      chat: meta.chat,
      from: meta.from,
      ts_ms: String(meta.tsMs),
      body: encodeBody({ content: { kind: meta.kind } }),
    },
  };
  return historyStatic<boolean>('historyIsUnread', { state, mark, self });
}

/** Правка содержимого (поля из события): для известной строки — содержимое целиком, для неизвестной — заплатка
 * `edit_patch` (вид строки ещё не известен; web накладывает её при показе). */
export type EditPatch = Partial<Pick<WireMessageContent, 'text' | 'entities' | 'webpage'>> & {
  // Поля содержимого целиком (правка геопозиции — координаты и параметры трансляции)
  fields?: Partial<WireMessageContent>;
};

export function applyEditPatch(content: WireMessageContent, patch: EditPatch): WireMessageContent {
  const next = { ...content };
  if (patch.text !== undefined) {
    const isText = next.kind === 'text';
    Object.assign(next, isText
      ? { text: patch.text, entities: patch.entities, webpage: patch.webpage }
      : { caption: patch.text, entities: patch.entities });
  }
  if (patch.fields) Object.assign(next, patch.fields);
  return next;
}

/** Строка кэша web по сведённому состоянию. Невидимая (удалённая, сирота) — `deleted`, без содержимого; локальное
 * (место в ленте, ✓✓ своего исходящего, время показа) — из прежней записи. */
export function storedFromState(
  state: HRowState, prev: WireStoredMessage | undefined, self: string,
  isOwn: (address: string) => boolean = (address) => address === self,
): WireStoredMessage | undefined {
  const view = viewOf(state);
  const chatAddress = addressForPeer(view.chat);
  if (!chatAddress) return undefined;
  const from = view.from || prev?.from || '';
  const isGroup = isGroupPeer(view.chat);
  const to = isGroup ? chatAddress : (isOwn(from) ? chatAddress : self);
  const anyStamp = state.gone?.stamp || state.edit_stamp || state.pin_stamp || state.reacts?.[0]?.stamp
    || state.pending_gones?.[0]?.stamp || state.pending_edits?.[0]?.stamp;
  const tsMs = view.tsMs ?? Number(anyStamp?.ts_ms || 0);
  const ts = prev?.ts ?? Math.floor(tsMs / MS_IN_SECOND);
  if (!view.visible) {
    return {
      id: view.id, from, to, ts, content: { kind: 'unsupported' }, deleted: true, origin: 'v2', hs: state,
      order: prev?.order,
    };
  }
  const {
    content: rawContent, edit_patch: editPatch, reply_to: replyTo, proof, ...rest
  } = view.body || {};
  let content = (rawContent && typeof rawContent === 'object' ? rawContent : { kind: 'unsupported' }) as
    WireMessageContent;
  if (editPatch && typeof editPatch === 'object') content = applyEditPatch(content, editPatch);
  const reactors: WireReactor[] = (state.reacts || []).filter((r) => r.emoji).map((r) => ({
    user: r.user, emoji: r.emoji!, ts: Math.floor(Number(r.stamp.ts_ms) / MS_IN_SECOND),
  }));
  const stored: WireStoredMessage = {
    ...(rest as Partial<WireStoredMessage>),
    id: view.id,
    from,
    to,
    ts,
    content,
    reply_to: typeof replyTo === 'string' ? replyTo : undefined,
    proof: typeof proof === 'string' ? proof : undefined,
    edited: view.edited || undefined,
    reactions: view.reactions.length ? view.reactions.map((r) => ({
      emoji: r.emoji, count: r.count, mine: r.users.some(isOwn) || undefined,
    })) : undefined,
    reactors: reactors.length ? reactors : undefined,
    pinned: view.pinned || undefined,
    read: prev?.read,
    order: prev?.order,
    origin: 'v2',
    hs: state,
  };
  return stored;
}

/** Время строки в мс для маркера: из сведённого состояния, иначе секунды строки. */
export function rowTsMs(stored: WireStoredMessage) {
  const ts = stored.hs?.row?.ts_ms;
  return ts !== undefined ? Number(ts) : stored.ts * MS_IN_SECOND;
}

/** Состояние строки, ещё не знающей журнала (кэш прежних версий): строка и её реакции/закреп. Для переноса (FR-024)
 * и для первой мутации старой записи. */
export function legacyState(stored: WireStoredMessage, chat: HPeer): HRowState | undefined {
  if (!isJournalable(stored) || stored.deleted || !stored.from) return undefined;
  try {
    return buildLegacyState(stored, chat);
  } catch {
    // Строка, которую движок не принимает (битая запись кэша), — вне журнала
    return undefined;
  }
}

function buildLegacyState(stored: WireStoredMessage, chat: HPeer): HRowState {
  let state = applyOp(undefined, rowOpFromStored(stored, chat));
  const fallbackMs = stored.ts * MS_IN_SECOND;
  (stored.reactors || []).forEach((reactor) => {
    if (!reactor.emoji) return;
    state = applyOp(state, {
      react: {
        target: stored.id,
        chat,
        user: reactor.user,
        emoji: reactor.emoji,
        stamp: newStamp(reactor.ts * MS_IN_SECOND || fallbackMs),
      },
    });
  });
  if (stored.pinned) {
    state = applyOp(state, { pin: { target: stored.id, chat, stamp: newStamp(fallbackMs), pinned: true } });
  }
  return state;
}

export function stateTsMs(state: HRowState) {
  return Number(state.row?.ts_ms || 0);
}

function hexToB64(hex: string) {
  return bytesToBase64(Uint8Array.from((hex.match(/../g) || []).map((h) => parseInt(h, 16))));
}

function b64ToHex(b64: string) {
  return Array.from(base64ToBytes(b64), (b) => b.toString(16).padStart(2, '0')).join('');
}
