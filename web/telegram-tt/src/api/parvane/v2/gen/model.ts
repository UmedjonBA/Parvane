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

export const DeleteScopeValues = ['DELETE_SCOPE_UNSPECIFIED', 'DELETE_SCOPE_ME', 'DELETE_SCOPE_EVERYONE'] as const;
export type DeleteScope = typeof DeleteScopeValues[number];
export function deleteScopeFromJson(v: unknown): DeleteScope {
  const all = DeleteScopeValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as DeleteScope;
  const n = Number(v);
  const byNum: Record<number, DeleteScope> = { 0: 'DELETE_SCOPE_UNSPECIFIED', 1: 'DELETE_SCOPE_ME', 2: 'DELETE_SCOPE_EVERYONE' };
  return byNum[n] ?? DeleteScopeValues[0];
}

export const DeliveryValues = ['DELIVERY_UNSPECIFIED', 'DELIVERY_PENDING', 'DELIVERY_SENT', 'DELIVERY_READ', 'DELIVERY_FAILED'] as const;
export type Delivery = typeof DeliveryValues[number];
export function deliveryFromJson(v: unknown): Delivery {
  const all = DeliveryValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as Delivery;
  const n = Number(v);
  const byNum: Record<number, Delivery> = { 0: 'DELIVERY_UNSPECIFIED', 1: 'DELIVERY_PENDING', 2: 'DELIVERY_SENT', 3: 'DELIVERY_READ', 4: 'DELIVERY_FAILED' };
  return byNum[n] ?? DeliveryValues[0];
}

export const DispositionValues = ['DISPOSITION_UNSPECIFIED', 'DISPOSITION_SHOW', 'DISPOSITION_STUB', 'DISPOSITION_STUB_CRITICAL'] as const;
export type Disposition = typeof DispositionValues[number];
export function dispositionFromJson(v: unknown): Disposition {
  const all = DispositionValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as Disposition;
  const n = Number(v);
  const byNum: Record<number, Disposition> = { 0: 'DISPOSITION_UNSPECIFIED', 1: 'DISPOSITION_SHOW', 2: 'DISPOSITION_STUB', 3: 'DISPOSITION_STUB_CRITICAL' };
  return byNum[n] ?? DispositionValues[0];
}

export const GroupRoleValues = ['GROUP_ROLE_UNSPECIFIED', 'GROUP_ROLE_MEMBER', 'GROUP_ROLE_ADMIN', 'GROUP_ROLE_OWNER', 'GROUP_ROLE_LEFT', 'GROUP_ROLE_BANNED'] as const;
export type GroupRole = typeof GroupRoleValues[number];
export function groupRoleFromJson(v: unknown): GroupRole {
  const all = GroupRoleValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as GroupRole;
  const n = Number(v);
  const byNum: Record<number, GroupRole> = { 0: 'GROUP_ROLE_UNSPECIFIED', 1: 'GROUP_ROLE_MEMBER', 2: 'GROUP_ROLE_ADMIN', 3: 'GROUP_ROLE_OWNER', 4: 'GROUP_ROLE_LEFT', 5: 'GROUP_ROLE_BANNED' };
  return byNum[n] ?? GroupRoleValues[0];
}

export const JournalWriteValues = ['JOURNAL_WRITE_UNSPECIFIED', 'JOURNAL_WRITE_OPEN', 'JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN', 'JOURNAL_WRITE_BLOCKED_TOO_NEW'] as const;
export type JournalWrite = typeof JournalWriteValues[number];
export function journalWriteFromJson(v: unknown): JournalWrite {
  const all = JournalWriteValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as JournalWrite;
  const n = Number(v);
  const byNum: Record<number, JournalWrite> = { 0: 'JOURNAL_WRITE_UNSPECIFIED', 1: 'JOURNAL_WRITE_OPEN', 2: 'JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN', 3: 'JOURNAL_WRITE_BLOCKED_TOO_NEW' };
  return byNum[n] ?? JournalWriteValues[0];
}

export const ObjectKindValues = ['OBJECT_KIND_UNSPECIFIED', 'OBJECT_KIND_FOLDER', 'OBJECT_KIND_BLOCK', 'OBJECT_KIND_PEER_NOTIFY', 'OBJECT_KIND_NOTIFY_DEFAULTS', 'OBJECT_KIND_DRAFT', 'OBJECT_KIND_SCHEDULED', 'OBJECT_KIND_ARCHIVE', 'OBJECT_KIND_PIN_LIST', 'OBJECT_KIND_CALL', 'OBJECT_KIND_GROUP_INVITE', 'OBJECT_KIND_PLANNER_CONTAINER', 'OBJECT_KIND_CLOUD_CONTAINER', 'OBJECT_KIND_UNREAD_MARK', 'OBJECT_KIND_QUICK_REACTION', 'OBJECT_KIND_STICKER_PACK', 'OBJECT_KIND_CONTACT', 'OBJECT_KIND_FOLDER_ORDER', 'OBJECT_KIND_CHAT_CLEARED', 'OBJECT_KIND_SAVED_GIF', 'OBJECT_KIND_FAVED_STICKER'] as const;
export type ObjectKind = typeof ObjectKindValues[number];
export function objectKindFromJson(v: unknown): ObjectKind {
  const all = ObjectKindValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as ObjectKind;
  const n = Number(v);
  const byNum: Record<number, ObjectKind> = { 0: 'OBJECT_KIND_UNSPECIFIED', 1: 'OBJECT_KIND_FOLDER', 2: 'OBJECT_KIND_BLOCK', 3: 'OBJECT_KIND_PEER_NOTIFY', 4: 'OBJECT_KIND_NOTIFY_DEFAULTS', 5: 'OBJECT_KIND_DRAFT', 6: 'OBJECT_KIND_SCHEDULED', 7: 'OBJECT_KIND_ARCHIVE', 8: 'OBJECT_KIND_PIN_LIST', 9: 'OBJECT_KIND_CALL', 10: 'OBJECT_KIND_GROUP_INVITE', 11: 'OBJECT_KIND_PLANNER_CONTAINER', 12: 'OBJECT_KIND_CLOUD_CONTAINER', 13: 'OBJECT_KIND_UNREAD_MARK', 14: 'OBJECT_KIND_QUICK_REACTION', 15: 'OBJECT_KIND_STICKER_PACK', 16: 'OBJECT_KIND_CONTACT', 17: 'OBJECT_KIND_FOLDER_ORDER', 18: 'OBJECT_KIND_CHAT_CLEARED', 19: 'OBJECT_KIND_SAVED_GIF', 20: 'OBJECT_KIND_FAVED_STICKER' };
  return byNum[n] ?? ObjectKindValues[0];
}

export const OpenStateValues = ['OPEN_STATE_UNSPECIFIED', 'OPEN_STATE_READY', 'OPEN_STATE_MIGRATION_NEEDED', 'OPEN_STATE_TOO_NEW', 'OPEN_STATE_LOCKED'] as const;
export type OpenState = typeof OpenStateValues[number];
export function openStateFromJson(v: unknown): OpenState {
  const all = OpenStateValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as OpenState;
  const n = Number(v);
  const byNum: Record<number, OpenState> = { 0: 'OPEN_STATE_UNSPECIFIED', 1: 'OPEN_STATE_READY', 2: 'OPEN_STATE_MIGRATION_NEEDED', 3: 'OPEN_STATE_TOO_NEW', 4: 'OPEN_STATE_LOCKED' };
  return byNum[n] ?? OpenStateValues[0];
}

export const PageDirectionValues = ['PAGE_DIRECTION_UNSPECIFIED', 'PAGE_DIRECTION_OLDER', 'PAGE_DIRECTION_NEWER', 'PAGE_DIRECTION_AROUND'] as const;
export type PageDirection = typeof PageDirectionValues[number];
export function pageDirectionFromJson(v: unknown): PageDirection {
  const all = PageDirectionValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as PageDirection;
  const n = Number(v);
  const byNum: Record<number, PageDirection> = { 0: 'PAGE_DIRECTION_UNSPECIFIED', 1: 'PAGE_DIRECTION_OLDER', 2: 'PAGE_DIRECTION_NEWER', 3: 'PAGE_DIRECTION_AROUND' };
  return byNum[n] ?? PageDirectionValues[0];
}

export const RequestChannelValues = ['REQUEST_CHANNEL_UNSPECIFIED', 'REQUEST_CHANNEL_ID', 'REQUEST_CHANNEL_ANON'] as const;
export type RequestChannel = typeof RequestChannelValues[number];
export function requestChannelFromJson(v: unknown): RequestChannel {
  const all = RequestChannelValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as RequestChannel;
  const n = Number(v);
  const byNum: Record<number, RequestChannel> = { 0: 'REQUEST_CHANNEL_UNSPECIFIED', 1: 'REQUEST_CHANNEL_ID', 2: 'REQUEST_CHANNEL_ANON' };
  return byNum[n] ?? RequestChannelValues[0];
}

export const ServerInputKindValues = ['SERVER_INPUT_KIND_UNSPECIFIED', 'SERVER_INPUT_KIND_RESPONSE', 'SERVER_INPUT_KIND_EVENT', 'SERVER_INPUT_KIND_INBOX_RECORD', 'SERVER_INPUT_KIND_STREAM_CHUNK'] as const;
export type ServerInputKind = typeof ServerInputKindValues[number];
export function serverInputKindFromJson(v: unknown): ServerInputKind {
  const all = ServerInputKindValues as readonly string[];
  if (typeof v === 'string' && all.includes(v)) return v as ServerInputKind;
  const n = Number(v);
  const byNum: Record<number, ServerInputKind> = { 0: 'SERVER_INPUT_KIND_UNSPECIFIED', 1: 'SERVER_INPUT_KIND_RESPONSE', 2: 'SERVER_INPUT_KIND_EVENT', 3: 'SERVER_INPUT_KIND_INBOX_RECORD', 4: 'SERVER_INPUT_KIND_STREAM_CHUNK' };
  return byNum[n] ?? ServerInputKindValues[0];
}

export interface AuditDump {
  jsonl: string;
}

export function auditDumpFromJson(v: unknown): AuditDump {
  const j = (v ?? {}) as Record<string, unknown>;
  const jsonl = pick(j, 'jsonl', 'jsonl');
  const out: AuditDump = {
    jsonl: jsonl === undefined || jsonl === null ? '' : String(jsonl),
  };
  return out;
}

export function auditDumpToJson(m: AuditDump): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.jsonl === '')) j.jsonl = m.jsonl;
  return j;
}

export interface CallResult {
  resultJson: string;
}

export function callResultFromJson(v: unknown): CallResult {
  const j = (v ?? {}) as Record<string, unknown>;
  const resultJson = pick(j, 'result_json', 'resultJson');
  const out: CallResult = {
    resultJson: resultJson === undefined || resultJson === null ? '' : String(resultJson),
  };
  return out;
}

export function callResultToJson(m: CallResult): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.resultJson === '')) j.result_json = m.resultJson;
  return j;
}

export interface Capabilities {
  sendText: boolean;
  sendMedia: boolean;
  sendStickers: boolean;
  sendPolls: boolean;
  sendLinks: boolean;
  deleteEveryone: boolean;
  pin: boolean;
  edit: boolean;
  react: boolean;
  forward: boolean;
  reply: boolean;
}

export function capabilitiesFromJson(v: unknown): Capabilities {
  const j = (v ?? {}) as Record<string, unknown>;
  const sendText = pick(j, 'send_text', 'sendText');
  const sendMedia = pick(j, 'send_media', 'sendMedia');
  const sendStickers = pick(j, 'send_stickers', 'sendStickers');
  const sendPolls = pick(j, 'send_polls', 'sendPolls');
  const sendLinks = pick(j, 'send_links', 'sendLinks');
  const deleteEveryone = pick(j, 'delete_everyone', 'deleteEveryone');
  const pin = pick(j, 'pin', 'pin');
  const edit = pick(j, 'edit', 'edit');
  const react = pick(j, 'react', 'react');
  const forward = pick(j, 'forward', 'forward');
  const reply = pick(j, 'reply', 'reply');
  const out: Capabilities = {
    sendText: sendText === undefined || sendText === null ? false : Boolean(sendText),
    sendMedia: sendMedia === undefined || sendMedia === null ? false : Boolean(sendMedia),
    sendStickers: sendStickers === undefined || sendStickers === null ? false : Boolean(sendStickers),
    sendPolls: sendPolls === undefined || sendPolls === null ? false : Boolean(sendPolls),
    sendLinks: sendLinks === undefined || sendLinks === null ? false : Boolean(sendLinks),
    deleteEveryone: deleteEveryone === undefined || deleteEveryone === null ? false : Boolean(deleteEveryone),
    pin: pin === undefined || pin === null ? false : Boolean(pin),
    edit: edit === undefined || edit === null ? false : Boolean(edit),
    react: react === undefined || react === null ? false : Boolean(react),
    forward: forward === undefined || forward === null ? false : Boolean(forward),
    reply: reply === undefined || reply === null ? false : Boolean(reply),
  };
  return out;
}

export function capabilitiesToJson(m: Capabilities): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(!m.sendText)) j.send_text = m.sendText;
  if (!(!m.sendMedia)) j.send_media = m.sendMedia;
  if (!(!m.sendStickers)) j.send_stickers = m.sendStickers;
  if (!(!m.sendPolls)) j.send_polls = m.sendPolls;
  if (!(!m.sendLinks)) j.send_links = m.sendLinks;
  if (!(!m.deleteEveryone)) j.delete_everyone = m.deleteEveryone;
  if (!(!m.pin)) j.pin = m.pin;
  if (!(!m.edit)) j.edit = m.edit;
  if (!(!m.react)) j.react = m.react;
  if (!(!m.forward)) j.forward = m.forward;
  if (!(!m.reply)) j.reply = m.reply;
  return j;
}

export interface CapabilitiesRequest {
  chat?: Peer;
}

export function capabilitiesRequestFromJson(v: unknown): CapabilitiesRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const out: CapabilitiesRequest = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
  };
  return out;
}

export function capabilitiesRequestToJson(m: CapabilitiesRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  return j;
}

export interface ChatAnchor {
  tsMs: string;
  chatKey: string;
}

export function chatAnchorFromJson(v: unknown): ChatAnchor {
  const j = (v ?? {}) as Record<string, unknown>;
  const tsMs = pick(j, 'ts_ms', 'tsMs');
  const chatKey = pick(j, 'chat_key', 'chatKey');
  const out: ChatAnchor = {
    tsMs: tsMs === undefined || tsMs === null ? '' : String(tsMs),
    chatKey: chatKey === undefined || chatKey === null ? '' : String(chatKey),
  };
  return out;
}

export function chatAnchorToJson(m: ChatAnchor): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.tsMs === '' || m.tsMs === '0'))) j.ts_ms = m.tsMs;
  if (!(m.chatKey === '')) j.chat_key = m.chatKey;
  return j;
}

export interface ChatListRequest {
  after?: ChatAnchor;
  limit: number;
  folder: number;
}

export function chatListRequestFromJson(v: unknown): ChatListRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const after = pick(j, 'after', 'after');
  const limit = pick(j, 'limit', 'limit');
  const folder = pick(j, 'folder', 'folder');
  const out: ChatListRequest = {
    after: after === undefined || after === null ? undefined : chatAnchorFromJson(after),
    limit: limit === undefined || limit === null ? 0 : Number(limit),
    folder: folder === undefined || folder === null ? 0 : Number(folder),
  };
  return out;
}

export function chatListRequestToJson(m: ChatListRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.after === undefined)) j.after = chatAnchorToJson(m.after!);
  if (!(m.limit === 0)) j.limit = m.limit;
  if (!(m.folder === 0)) j.folder = m.folder;
  return j;
}

export interface ChatPage {
  chats: ChatView[];
  next?: ChatAnchor;
}

export function chatPageFromJson(v: unknown): ChatPage {
  const j = (v ?? {}) as Record<string, unknown>;
  const chats = pick(j, 'chats', 'chats');
  const next = pick(j, 'next', 'next');
  const out: ChatPage = {
    chats: Array.isArray(chats) ? chats.map((x) => chatViewFromJson(x)) : [],
    next: next === undefined || next === null ? undefined : chatAnchorFromJson(next),
  };
  return out;
}

export function chatPageToJson(m: ChatPage): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.chats.length) j.chats = m.chats.map((x) => chatViewToJson(x));
  if (!(m.next === undefined)) j.next = chatAnchorToJson(m.next!);
  return j;
}

export interface ChatView {
  chat?: Peer;
  title: string;
  photo?: ViewMedia;
  last?: MessageView;
  unread: number;
  mention: boolean;
  pinnedRank: number;
  archived: boolean;
  mutedUntilMs: string;
  draft: string;
  folderIds: number[];
}

export function chatViewFromJson(v: unknown): ChatView {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const title = pick(j, 'title', 'title');
  const photo = pick(j, 'photo', 'photo');
  const last = pick(j, 'last', 'last');
  const unread = pick(j, 'unread', 'unread');
  const mention = pick(j, 'mention', 'mention');
  const pinnedRank = pick(j, 'pinned_rank', 'pinnedRank');
  const archived = pick(j, 'archived', 'archived');
  const mutedUntilMs = pick(j, 'muted_until_ms', 'mutedUntilMs');
  const draft = pick(j, 'draft', 'draft');
  const folderIds = pick(j, 'folder_ids', 'folderIds');
  const out: ChatView = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    title: title === undefined || title === null ? '' : String(title),
    photo: photo === undefined || photo === null ? undefined : viewMediaFromJson(photo),
    last: last === undefined || last === null ? undefined : messageViewFromJson(last),
    unread: unread === undefined || unread === null ? 0 : Number(unread),
    mention: mention === undefined || mention === null ? false : Boolean(mention),
    pinnedRank: pinnedRank === undefined || pinnedRank === null ? 0 : Number(pinnedRank),
    archived: archived === undefined || archived === null ? false : Boolean(archived),
    mutedUntilMs: mutedUntilMs === undefined || mutedUntilMs === null ? '' : String(mutedUntilMs),
    draft: draft === undefined || draft === null ? '' : String(draft),
    folderIds: Array.isArray(folderIds) ? folderIds.map((x) => Number(x)) : [],
  };
  return out;
}

export function chatViewToJson(m: ChatView): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.title === '')) j.title = m.title;
  if (!(m.photo === undefined)) j.photo = viewMediaToJson(m.photo!);
  if (!(m.last === undefined)) j.last = messageViewToJson(m.last!);
  if (!(m.unread === 0)) j.unread = m.unread;
  if (!(!m.mention)) j.mention = m.mention;
  if (!(m.pinnedRank === 0)) j.pinned_rank = m.pinnedRank;
  if (!(!m.archived)) j.archived = m.archived;
  if (!((m.mutedUntilMs === '' || m.mutedUntilMs === '0'))) j.muted_until_ms = m.mutedUntilMs;
  if (!(m.draft === '')) j.draft = m.draft;
  if (m.folderIds.length) j.folder_ids = m.folderIds.map((x) => x);
  return j;
}

export interface ClientCall {
  name: string;
  argsJson: string;
}

export function clientCallFromJson(v: unknown): ClientCall {
  const j = (v ?? {}) as Record<string, unknown>;
  const name = pick(j, 'name', 'name');
  const argsJson = pick(j, 'args_json', 'argsJson');
  const out: ClientCall = {
    name: name === undefined || name === null ? '' : String(name),
    argsJson: argsJson === undefined || argsJson === null ? '' : String(argsJson),
  };
  return out;
}

export function clientCallToJson(m: ClientCall): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.name === '')) j.name = m.name;
  if (!(m.argsJson === '')) j.args_json = m.argsJson;
  return j;
}

export interface ClientEvents {
  json: string;
}

export function clientEventsFromJson(v: unknown): ClientEvents {
  const j = (v ?? {}) as Record<string, unknown>;
  const json = pick(j, 'json', 'json');
  const out: ClientEvents = {
    json: json === undefined || json === null ? '' : String(json),
  };
  return out;
}

export function clientEventsToJson(m: ClientEvents): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.json === '')) j.json = m.json;
  return j;
}

export interface ClientReplace {
  mode: string;
  blob: Uint8Array;
  key: Uint8Array;
}

export function clientReplaceFromJson(v: unknown): ClientReplace {
  const j = (v ?? {}) as Record<string, unknown>;
  const mode = pick(j, 'mode', 'mode');
  const blob = pick(j, 'blob', 'blob');
  const key = pick(j, 'key', 'key');
  const out: ClientReplace = {
    mode: mode === undefined || mode === null ? '' : String(mode),
    blob: blob === undefined || blob === null ? new Uint8Array(0) : fromBase64(String(blob)),
    key: key === undefined || key === null ? new Uint8Array(0) : fromBase64(String(key)),
  };
  return out;
}

export function clientReplaceToJson(m: ClientReplace): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.mode === '')) j.mode = m.mode;
  if (!(m.blob.length === 0)) j.blob = toBase64(m.blob);
  if (!(m.key.length === 0)) j.key = toBase64(m.key);
  return j;
}

export interface ComposeContent {
  replyTo: Uint8Array;
  silent: boolean;
  kind?: { case: 'text'; value: ViewText } | { case: 'media'; value: ViewMedia } | { case: 'sticker'; value: ViewSticker } | { case: 'poll'; value: ViewPoll } | { case: 'location'; value: ViewLocation } | { case: 'contact'; value: ViewContact } | { case: 'article'; value: ViewArticle };
}

export function composeContentFromJson(v: unknown): ComposeContent {
  const j = (v ?? {}) as Record<string, unknown>;
  const replyTo = pick(j, 'reply_to', 'replyTo');
  const silent = pick(j, 'silent', 'silent');
  const out: ComposeContent = {
    replyTo: replyTo === undefined || replyTo === null ? new Uint8Array(0) : fromBase64(String(replyTo)),
    silent: silent === undefined || silent === null ? false : Boolean(silent),
  };
  {
    const x = pick(j, 'text', 'text');
    if (x !== undefined && x !== null) out.kind = { case: 'text', value: viewTextFromJson(x) };
  }
  {
    const x = pick(j, 'media', 'media');
    if (x !== undefined && x !== null) out.kind = { case: 'media', value: viewMediaFromJson(x) };
  }
  {
    const x = pick(j, 'sticker', 'sticker');
    if (x !== undefined && x !== null) out.kind = { case: 'sticker', value: viewStickerFromJson(x) };
  }
  {
    const x = pick(j, 'poll', 'poll');
    if (x !== undefined && x !== null) out.kind = { case: 'poll', value: viewPollFromJson(x) };
  }
  {
    const x = pick(j, 'location', 'location');
    if (x !== undefined && x !== null) out.kind = { case: 'location', value: viewLocationFromJson(x) };
  }
  {
    const x = pick(j, 'contact', 'contact');
    if (x !== undefined && x !== null) out.kind = { case: 'contact', value: viewContactFromJson(x) };
  }
  {
    const x = pick(j, 'article', 'article');
    if (x !== undefined && x !== null) out.kind = { case: 'article', value: viewArticleFromJson(x) };
  }
  return out;
}

export function composeContentToJson(m: ComposeContent): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.replyTo.length === 0)) j.reply_to = toBase64(m.replyTo);
  if (!(!m.silent)) j.silent = m.silent;
  if (m.kind?.case === 'text') j.text = viewTextToJson(m.kind.value);
  if (m.kind?.case === 'media') j.media = viewMediaToJson(m.kind.value);
  if (m.kind?.case === 'sticker') j.sticker = viewStickerToJson(m.kind.value);
  if (m.kind?.case === 'poll') j.poll = viewPollToJson(m.kind.value);
  if (m.kind?.case === 'location') j.location = viewLocationToJson(m.kind.value);
  if (m.kind?.case === 'contact') j.contact = viewContactToJson(m.kind.value);
  if (m.kind?.case === 'article') j.article = viewArticleToJson(m.kind.value);
  return j;
}

export interface CriticalRange {
  name: string;
  from: number;
  to: number;
}

export function criticalRangeFromJson(v: unknown): CriticalRange {
  const j = (v ?? {}) as Record<string, unknown>;
  const name = pick(j, 'name', 'name');
  const from = pick(j, 'from', 'from');
  const to = pick(j, 'to', 'to');
  const out: CriticalRange = {
    name: name === undefined || name === null ? '' : String(name),
    from: from === undefined || from === null ? 0 : Number(from),
    to: to === undefined || to === null ? 0 : Number(to),
  };
  return out;
}

export function criticalRangeToJson(m: CriticalRange): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.name === '')) j.name = m.name;
  if (!(m.from === 0)) j.from = m.from;
  if (!(m.to === 0)) j.to = m.to;
  return j;
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

export interface EngineConfig {
  user: string;
  deviceId: string;
  domain: string;
  features: string[];
  nowMs: string;
  memoryBudgetBytes: string;
  deviceKey: Uint8Array;
  vectors: boolean;
  legacyPresent: boolean;
  hostDriven: boolean;
}

export function engineConfigFromJson(v: unknown): EngineConfig {
  const j = (v ?? {}) as Record<string, unknown>;
  const user = pick(j, 'user', 'user');
  const deviceId = pick(j, 'device_id', 'deviceId');
  const domain = pick(j, 'domain', 'domain');
  const features = pick(j, 'features', 'features');
  const nowMs = pick(j, 'now_ms', 'nowMs');
  const memoryBudgetBytes = pick(j, 'memory_budget_bytes', 'memoryBudgetBytes');
  const deviceKey = pick(j, 'device_key', 'deviceKey');
  const vectors = pick(j, 'vectors', 'vectors');
  const legacyPresent = pick(j, 'legacy_present', 'legacyPresent');
  const hostDriven = pick(j, 'host_driven', 'hostDriven');
  const out: EngineConfig = {
    user: user === undefined || user === null ? '' : String(user),
    deviceId: deviceId === undefined || deviceId === null ? '' : String(deviceId),
    domain: domain === undefined || domain === null ? '' : String(domain),
    features: Array.isArray(features) ? features.map((x) => String(x)) : [],
    nowMs: nowMs === undefined || nowMs === null ? '' : String(nowMs),
    memoryBudgetBytes: memoryBudgetBytes === undefined || memoryBudgetBytes === null ? '' : String(memoryBudgetBytes),
    deviceKey: deviceKey === undefined || deviceKey === null ? new Uint8Array(0) : fromBase64(String(deviceKey)),
    vectors: vectors === undefined || vectors === null ? false : Boolean(vectors),
    legacyPresent: legacyPresent === undefined || legacyPresent === null ? false : Boolean(legacyPresent),
    hostDriven: hostDriven === undefined || hostDriven === null ? false : Boolean(hostDriven),
  };
  return out;
}

export function engineConfigToJson(m: EngineConfig): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.user === '')) j.user = m.user;
  if (!(m.deviceId === '')) j.device_id = m.deviceId;
  if (!(m.domain === '')) j.domain = m.domain;
  if (m.features.length) j.features = m.features.map((x) => x);
  if (!((m.nowMs === '' || m.nowMs === '0'))) j.now_ms = m.nowMs;
  if (!((m.memoryBudgetBytes === '' || m.memoryBudgetBytes === '0'))) j.memory_budget_bytes = m.memoryBudgetBytes;
  if (!(m.deviceKey.length === 0)) j.device_key = toBase64(m.deviceKey);
  if (!(!m.vectors)) j.vectors = m.vectors;
  if (!(!m.legacyPresent)) j.legacy_present = m.legacyPresent;
  if (!(!m.hostDriven)) j.host_driven = m.hostDriven;
  return j;
}

export interface EngineError {
  error: string;
}

export function engineErrorFromJson(v: unknown): EngineError {
  const j = (v ?? {}) as Record<string, unknown>;
  const error = pick(j, 'error', 'error');
  const out: EngineError = {
    error: error === undefined || error === null ? '' : String(error),
  };
  return out;
}

export function engineErrorToJson(m: EngineError): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.error === '')) j.error = m.error;
  return j;
}

export interface EngineInfo {
  engineApi: string;
  protoMajor: number;
  protoMinor: number;
  minSupportedMinor: number;
  features: string[];
  storageFormats: StorageFormat[];
  criticalRanges: CriticalRange[];
  sourceHash: string;
  schemaHash: string;
  buildId: string;
  target: string;
}

export function engineInfoFromJson(v: unknown): EngineInfo {
  const j = (v ?? {}) as Record<string, unknown>;
  const engineApi = pick(j, 'engine_api', 'engineApi');
  const protoMajor = pick(j, 'proto_major', 'protoMajor');
  const protoMinor = pick(j, 'proto_minor', 'protoMinor');
  const minSupportedMinor = pick(j, 'min_supported_minor', 'minSupportedMinor');
  const features = pick(j, 'features', 'features');
  const storageFormats = pick(j, 'storage_formats', 'storageFormats');
  const criticalRanges = pick(j, 'critical_ranges', 'criticalRanges');
  const sourceHash = pick(j, 'source_hash', 'sourceHash');
  const schemaHash = pick(j, 'schema_hash', 'schemaHash');
  const buildId = pick(j, 'build_id', 'buildId');
  const target = pick(j, 'target', 'target');
  const out: EngineInfo = {
    engineApi: engineApi === undefined || engineApi === null ? '' : String(engineApi),
    protoMajor: protoMajor === undefined || protoMajor === null ? 0 : Number(protoMajor),
    protoMinor: protoMinor === undefined || protoMinor === null ? 0 : Number(protoMinor),
    minSupportedMinor: minSupportedMinor === undefined || minSupportedMinor === null ? 0 : Number(minSupportedMinor),
    features: Array.isArray(features) ? features.map((x) => String(x)) : [],
    storageFormats: Array.isArray(storageFormats) ? storageFormats.map((x) => storageFormatFromJson(x)) : [],
    criticalRanges: Array.isArray(criticalRanges) ? criticalRanges.map((x) => criticalRangeFromJson(x)) : [],
    sourceHash: sourceHash === undefined || sourceHash === null ? '' : String(sourceHash),
    schemaHash: schemaHash === undefined || schemaHash === null ? '' : String(schemaHash),
    buildId: buildId === undefined || buildId === null ? '' : String(buildId),
    target: target === undefined || target === null ? '' : String(target),
  };
  return out;
}

export function engineInfoToJson(m: EngineInfo): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.engineApi === '')) j.engine_api = m.engineApi;
  if (!(m.protoMajor === 0)) j.proto_major = m.protoMajor;
  if (!(m.protoMinor === 0)) j.proto_minor = m.protoMinor;
  if (!(m.minSupportedMinor === 0)) j.min_supported_minor = m.minSupportedMinor;
  if (m.features.length) j.features = m.features.map((x) => x);
  if (m.storageFormats.length) j.storage_formats = m.storageFormats.map((x) => storageFormatToJson(x));
  if (m.criticalRanges.length) j.critical_ranges = m.criticalRanges.map((x) => criticalRangeToJson(x));
  if (!(m.sourceHash === '')) j.source_hash = m.sourceHash;
  if (!(m.schemaHash === '')) j.schema_hash = m.schemaHash;
  if (!(m.buildId === '')) j.build_id = m.buildId;
  if (!(m.target === '')) j.target = m.target;
  return j;
}

export interface FieldValue {
  field: number;
  value: Uint8Array;
}

export function fieldValueFromJson(v: unknown): FieldValue {
  const j = (v ?? {}) as Record<string, unknown>;
  const field = pick(j, 'field', 'field');
  const value = pick(j, 'value', 'value');
  const out: FieldValue = {
    field: field === undefined || field === null ? 0 : Number(field),
    value: value === undefined || value === null ? new Uint8Array(0) : fromBase64(String(value)),
  };
  return out;
}

export function fieldValueToJson(m: FieldValue): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.field === 0)) j.field = m.field;
  if (!(m.value.length === 0)) j.value = toBase64(m.value);
  return j;
}

export interface GroupPerms {
  sendMedia: boolean;
  sendStickers: boolean;
  sendPolls: boolean;
  sendLinks: boolean;
  invite: boolean;
  pin: boolean;
  changeInfo: boolean;
}

export function groupPermsFromJson(v: unknown): GroupPerms {
  const j = (v ?? {}) as Record<string, unknown>;
  const sendMedia = pick(j, 'send_media', 'sendMedia');
  const sendStickers = pick(j, 'send_stickers', 'sendStickers');
  const sendPolls = pick(j, 'send_polls', 'sendPolls');
  const sendLinks = pick(j, 'send_links', 'sendLinks');
  const invite = pick(j, 'invite', 'invite');
  const pin = pick(j, 'pin', 'pin');
  const changeInfo = pick(j, 'change_info', 'changeInfo');
  const out: GroupPerms = {
    sendMedia: sendMedia === undefined || sendMedia === null ? false : Boolean(sendMedia),
    sendStickers: sendStickers === undefined || sendStickers === null ? false : Boolean(sendStickers),
    sendPolls: sendPolls === undefined || sendPolls === null ? false : Boolean(sendPolls),
    sendLinks: sendLinks === undefined || sendLinks === null ? false : Boolean(sendLinks),
    invite: invite === undefined || invite === null ? false : Boolean(invite),
    pin: pin === undefined || pin === null ? false : Boolean(pin),
    changeInfo: changeInfo === undefined || changeInfo === null ? false : Boolean(changeInfo),
  };
  return out;
}

export function groupPermsToJson(m: GroupPerms): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(!m.sendMedia)) j.send_media = m.sendMedia;
  if (!(!m.sendStickers)) j.send_stickers = m.sendStickers;
  if (!(!m.sendPolls)) j.send_polls = m.sendPolls;
  if (!(!m.sendLinks)) j.send_links = m.sendLinks;
  if (!(!m.invite)) j.invite = m.invite;
  if (!(!m.pin)) j.pin = m.pin;
  if (!(!m.changeInfo)) j.change_info = m.changeInfo;
  return j;
}

export interface GroupView {
  group?: Ref;
  kind: string;
  title: string;
  about: string;
  photo?: ViewMedia;
  membersCount: number;
  myRole: GroupRole;
  perms?: GroupPerms;
  isPublic: boolean;
  inviteLinks: string[];
}

export function groupViewFromJson(v: unknown): GroupView {
  const j = (v ?? {}) as Record<string, unknown>;
  const group = pick(j, 'group', 'group');
  const kind = pick(j, 'kind', 'kind');
  const title = pick(j, 'title', 'title');
  const about = pick(j, 'about', 'about');
  const photo = pick(j, 'photo', 'photo');
  const membersCount = pick(j, 'members_count', 'membersCount');
  const myRole = pick(j, 'my_role', 'myRole');
  const perms = pick(j, 'perms', 'perms');
  const isPublic = pick(j, 'is_public', 'isPublic');
  const inviteLinks = pick(j, 'invite_links', 'inviteLinks');
  const out: GroupView = {
    group: group === undefined || group === null ? undefined : refFromJson(group),
    kind: kind === undefined || kind === null ? '' : String(kind),
    title: title === undefined || title === null ? '' : String(title),
    about: about === undefined || about === null ? '' : String(about),
    photo: photo === undefined || photo === null ? undefined : viewMediaFromJson(photo),
    membersCount: membersCount === undefined || membersCount === null ? 0 : Number(membersCount),
    myRole: myRole === undefined || myRole === null ? GroupRoleValues[0] : groupRoleFromJson(myRole),
    perms: perms === undefined || perms === null ? undefined : groupPermsFromJson(perms),
    isPublic: isPublic === undefined || isPublic === null ? false : Boolean(isPublic),
    inviteLinks: Array.isArray(inviteLinks) ? inviteLinks.map((x) => String(x)) : [],
  };
  return out;
}

export function groupViewToJson(m: GroupView): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.group === undefined)) j.group = refToJson(m.group!);
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.title === '')) j.title = m.title;
  if (!(m.about === '')) j.about = m.about;
  if (!(m.photo === undefined)) j.photo = viewMediaToJson(m.photo!);
  if (!(m.membersCount === 0)) j.members_count = m.membersCount;
  if (!(m.myRole === GroupRoleValues[0])) j.my_role = m.myRole;
  if (!(m.perms === undefined)) j.perms = groupPermsToJson(m.perms!);
  if (!(!m.isPublic)) j.is_public = m.isPublic;
  if (m.inviteLinks.length) j.invite_links = m.inviteLinks.map((x) => x);
  return j;
}

export interface HistoryPage {
  rows: MessageView[];
  older?: MsgAnchor;
  newer?: MsgAnchor;
  hasOlder: boolean;
  hasNewer: boolean;
  pending?: StoreReads;
}

export function historyPageFromJson(v: unknown): HistoryPage {
  const j = (v ?? {}) as Record<string, unknown>;
  const rows = pick(j, 'rows', 'rows');
  const older = pick(j, 'older', 'older');
  const newer = pick(j, 'newer', 'newer');
  const hasOlder = pick(j, 'has_older', 'hasOlder');
  const hasNewer = pick(j, 'has_newer', 'hasNewer');
  const pending = pick(j, 'pending', 'pending');
  const out: HistoryPage = {
    rows: Array.isArray(rows) ? rows.map((x) => messageViewFromJson(x)) : [],
    older: older === undefined || older === null ? undefined : msgAnchorFromJson(older),
    newer: newer === undefined || newer === null ? undefined : msgAnchorFromJson(newer),
    hasOlder: hasOlder === undefined || hasOlder === null ? false : Boolean(hasOlder),
    hasNewer: hasNewer === undefined || hasNewer === null ? false : Boolean(hasNewer),
    pending: pending === undefined || pending === null ? undefined : storeReadsFromJson(pending),
  };
  return out;
}

export function historyPageToJson(m: HistoryPage): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.rows.length) j.rows = m.rows.map((x) => messageViewToJson(x));
  if (!(m.older === undefined)) j.older = msgAnchorToJson(m.older!);
  if (!(m.newer === undefined)) j.newer = msgAnchorToJson(m.newer!);
  if (!(!m.hasOlder)) j.has_older = m.hasOlder;
  if (!(!m.hasNewer)) j.has_newer = m.hasNewer;
  if (!(m.pending === undefined)) j.pending = storeReadsToJson(m.pending!);
  return j;
}

export interface HistoryPageRequest {
  chat?: Peer;
  anchor?: MsgAnchor;
  direction: PageDirection;
  limit: number;
}

export function historyPageRequestFromJson(v: unknown): HistoryPageRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const anchor = pick(j, 'anchor', 'anchor');
  const direction = pick(j, 'direction', 'direction');
  const limit = pick(j, 'limit', 'limit');
  const out: HistoryPageRequest = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    anchor: anchor === undefined || anchor === null ? undefined : msgAnchorFromJson(anchor),
    direction: direction === undefined || direction === null ? PageDirectionValues[0] : pageDirectionFromJson(direction),
    limit: limit === undefined || limit === null ? 0 : Number(limit),
  };
  return out;
}

export function historyPageRequestToJson(m: HistoryPageRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.anchor === undefined)) j.anchor = msgAnchorToJson(m.anchor!);
  if (!(m.direction === PageDirectionValues[0])) j.direction = m.direction;
  if (!(m.limit === 0)) j.limit = m.limit;
  return j;
}

export interface Intent {
  kind?: { case: 'send'; value: IntentSend } | { case: 'edit'; value: IntentEdit } | { case: 'deleteMessages'; value: IntentDelete } | { case: 'react'; value: IntentReact } | { case: 'pin'; value: IntentPin } | { case: 'read'; value: IntentRead } | { case: 'typing'; value: IntentTyping } | { case: 'statePatch'; value: IntentStatePatch } | { case: 'stateCreate'; value: IntentStateCreate } | { case: 'stateDelete'; value: IntentStateDelete } | { case: 'stateSetAdd'; value: IntentStateSetAdd } | { case: 'stateSetRemove'; value: IntentStateSetRemove } | { case: 'groupCreate'; value: IntentGroupCreate } | { case: 'groupChange'; value: IntentGroupChange } | { case: 'groupJoinByLink'; value: IntentGroupJoinByLink } | { case: 'domainOp'; value: IntentDomainOp } | { case: 'faveSticker'; value: IntentFaveSticker } | { case: 'rotateSsk'; value: IntentRotateSsk } | { case: 'revoke'; value: IntentRevoke };
}

export function intentFromJson(v: unknown): Intent {
  const j = (v ?? {}) as Record<string, unknown>;
  const out: Intent = {
  };
  {
    const x = pick(j, 'send', 'send');
    if (x !== undefined && x !== null) out.kind = { case: 'send', value: intentSendFromJson(x) };
  }
  {
    const x = pick(j, 'edit', 'edit');
    if (x !== undefined && x !== null) out.kind = { case: 'edit', value: intentEditFromJson(x) };
  }
  {
    const x = pick(j, 'delete_messages', 'deleteMessages');
    if (x !== undefined && x !== null) out.kind = { case: 'deleteMessages', value: intentDeleteFromJson(x) };
  }
  {
    const x = pick(j, 'react', 'react');
    if (x !== undefined && x !== null) out.kind = { case: 'react', value: intentReactFromJson(x) };
  }
  {
    const x = pick(j, 'pin', 'pin');
    if (x !== undefined && x !== null) out.kind = { case: 'pin', value: intentPinFromJson(x) };
  }
  {
    const x = pick(j, 'read', 'read');
    if (x !== undefined && x !== null) out.kind = { case: 'read', value: intentReadFromJson(x) };
  }
  {
    const x = pick(j, 'typing', 'typing');
    if (x !== undefined && x !== null) out.kind = { case: 'typing', value: intentTypingFromJson(x) };
  }
  {
    const x = pick(j, 'state_patch', 'statePatch');
    if (x !== undefined && x !== null) out.kind = { case: 'statePatch', value: intentStatePatchFromJson(x) };
  }
  {
    const x = pick(j, 'state_create', 'stateCreate');
    if (x !== undefined && x !== null) out.kind = { case: 'stateCreate', value: intentStateCreateFromJson(x) };
  }
  {
    const x = pick(j, 'state_delete', 'stateDelete');
    if (x !== undefined && x !== null) out.kind = { case: 'stateDelete', value: intentStateDeleteFromJson(x) };
  }
  {
    const x = pick(j, 'state_set_add', 'stateSetAdd');
    if (x !== undefined && x !== null) out.kind = { case: 'stateSetAdd', value: intentStateSetAddFromJson(x) };
  }
  {
    const x = pick(j, 'state_set_remove', 'stateSetRemove');
    if (x !== undefined && x !== null) out.kind = { case: 'stateSetRemove', value: intentStateSetRemoveFromJson(x) };
  }
  {
    const x = pick(j, 'group_create', 'groupCreate');
    if (x !== undefined && x !== null) out.kind = { case: 'groupCreate', value: intentGroupCreateFromJson(x) };
  }
  {
    const x = pick(j, 'group_change', 'groupChange');
    if (x !== undefined && x !== null) out.kind = { case: 'groupChange', value: intentGroupChangeFromJson(x) };
  }
  {
    const x = pick(j, 'group_join_by_link', 'groupJoinByLink');
    if (x !== undefined && x !== null) out.kind = { case: 'groupJoinByLink', value: intentGroupJoinByLinkFromJson(x) };
  }
  {
    const x = pick(j, 'domain_op', 'domainOp');
    if (x !== undefined && x !== null) out.kind = { case: 'domainOp', value: intentDomainOpFromJson(x) };
  }
  {
    const x = pick(j, 'fave_sticker', 'faveSticker');
    if (x !== undefined && x !== null) out.kind = { case: 'faveSticker', value: intentFaveStickerFromJson(x) };
  }
  {
    const x = pick(j, 'rotate_ssk', 'rotateSsk');
    if (x !== undefined && x !== null) out.kind = { case: 'rotateSsk', value: intentRotateSskFromJson(x) };
  }
  {
    const x = pick(j, 'revoke', 'revoke');
    if (x !== undefined && x !== null) out.kind = { case: 'revoke', value: intentRevokeFromJson(x) };
  }
  return out;
}

export function intentToJson(m: Intent): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.kind?.case === 'send') j.send = intentSendToJson(m.kind.value);
  if (m.kind?.case === 'edit') j.edit = intentEditToJson(m.kind.value);
  if (m.kind?.case === 'deleteMessages') j.delete_messages = intentDeleteToJson(m.kind.value);
  if (m.kind?.case === 'react') j.react = intentReactToJson(m.kind.value);
  if (m.kind?.case === 'pin') j.pin = intentPinToJson(m.kind.value);
  if (m.kind?.case === 'read') j.read = intentReadToJson(m.kind.value);
  if (m.kind?.case === 'typing') j.typing = intentTypingToJson(m.kind.value);
  if (m.kind?.case === 'statePatch') j.state_patch = intentStatePatchToJson(m.kind.value);
  if (m.kind?.case === 'stateCreate') j.state_create = intentStateCreateToJson(m.kind.value);
  if (m.kind?.case === 'stateDelete') j.state_delete = intentStateDeleteToJson(m.kind.value);
  if (m.kind?.case === 'stateSetAdd') j.state_set_add = intentStateSetAddToJson(m.kind.value);
  if (m.kind?.case === 'stateSetRemove') j.state_set_remove = intentStateSetRemoveToJson(m.kind.value);
  if (m.kind?.case === 'groupCreate') j.group_create = intentGroupCreateToJson(m.kind.value);
  if (m.kind?.case === 'groupChange') j.group_change = intentGroupChangeToJson(m.kind.value);
  if (m.kind?.case === 'groupJoinByLink') j.group_join_by_link = intentGroupJoinByLinkToJson(m.kind.value);
  if (m.kind?.case === 'domainOp') j.domain_op = intentDomainOpToJson(m.kind.value);
  if (m.kind?.case === 'faveSticker') j.fave_sticker = intentFaveStickerToJson(m.kind.value);
  if (m.kind?.case === 'rotateSsk') j.rotate_ssk = intentRotateSskToJson(m.kind.value);
  if (m.kind?.case === 'revoke') j.revoke = intentRevokeToJson(m.kind.value);
  return j;
}

export interface IntentDelete {
  chat?: Peer;
  targets: Uint8Array[];
  scope: DeleteScope;
}

export function intentDeleteFromJson(v: unknown): IntentDelete {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const targets = pick(j, 'targets', 'targets');
  const scope = pick(j, 'scope', 'scope');
  const out: IntentDelete = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    targets: Array.isArray(targets) ? targets.map((x) => fromBase64(String(x))) : [],
    scope: scope === undefined || scope === null ? DeleteScopeValues[0] : deleteScopeFromJson(scope),
  };
  return out;
}

export function intentDeleteToJson(m: IntentDelete): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (m.targets.length) j.targets = m.targets.map((x) => toBase64(x));
  if (!(m.scope === DeleteScopeValues[0])) j.scope = m.scope;
  return j;
}

export interface IntentDomainOp {
  container?: Ref;
  op: Uint8Array;
}

export function intentDomainOpFromJson(v: unknown): IntentDomainOp {
  const j = (v ?? {}) as Record<string, unknown>;
  const container = pick(j, 'container', 'container');
  const op = pick(j, 'op', 'op');
  const out: IntentDomainOp = {
    container: container === undefined || container === null ? undefined : refFromJson(container),
    op: op === undefined || op === null ? new Uint8Array(0) : fromBase64(String(op)),
  };
  return out;
}

export function intentDomainOpToJson(m: IntentDomainOp): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.container === undefined)) j.container = refToJson(m.container!);
  if (!(m.op.length === 0)) j.op = toBase64(m.op);
  return j;
}

export interface IntentEdit {
  chat?: Peer;
  target: Uint8Array;
  content?: ComposeContent;
}

export function intentEditFromJson(v: unknown): IntentEdit {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const target = pick(j, 'target', 'target');
  const content = pick(j, 'content', 'content');
  const out: IntentEdit = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    target: target === undefined || target === null ? new Uint8Array(0) : fromBase64(String(target)),
    content: content === undefined || content === null ? undefined : composeContentFromJson(content),
  };
  return out;
}

export function intentEditToJson(m: IntentEdit): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.target.length === 0)) j.target = toBase64(m.target);
  if (!(m.content === undefined)) j.content = composeContentToJson(m.content!);
  return j;
}

export interface IntentFaveSticker {
  setId: string;
  stickerId: string;
  on: boolean;
}

export function intentFaveStickerFromJson(v: unknown): IntentFaveSticker {
  const j = (v ?? {}) as Record<string, unknown>;
  const setId = pick(j, 'set_id', 'setId');
  const stickerId = pick(j, 'sticker_id', 'stickerId');
  const on = pick(j, 'on', 'on');
  const out: IntentFaveSticker = {
    setId: setId === undefined || setId === null ? '' : String(setId),
    stickerId: stickerId === undefined || stickerId === null ? '' : String(stickerId),
    on: on === undefined || on === null ? false : Boolean(on),
  };
  return out;
}

export function intentFaveStickerToJson(m: IntentFaveSticker): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.setId === '')) j.set_id = m.setId;
  if (!(m.stickerId === '')) j.sticker_id = m.stickerId;
  if (!(!m.on)) j.on = m.on;
  return j;
}

export interface IntentGroupChange {
  group?: Ref;
  change: Uint8Array;
}

export function intentGroupChangeFromJson(v: unknown): IntentGroupChange {
  const j = (v ?? {}) as Record<string, unknown>;
  const group = pick(j, 'group', 'group');
  const change = pick(j, 'change', 'change');
  const out: IntentGroupChange = {
    group: group === undefined || group === null ? undefined : refFromJson(group),
    change: change === undefined || change === null ? new Uint8Array(0) : fromBase64(String(change)),
  };
  return out;
}

export function intentGroupChangeToJson(m: IntentGroupChange): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.group === undefined)) j.group = refToJson(m.group!);
  if (!(m.change.length === 0)) j.change = toBase64(m.change);
  return j;
}

export interface IntentGroupCreate {
  title: string;
  members: string[];
  kind: string;
}

export function intentGroupCreateFromJson(v: unknown): IntentGroupCreate {
  const j = (v ?? {}) as Record<string, unknown>;
  const title = pick(j, 'title', 'title');
  const members = pick(j, 'members', 'members');
  const kind = pick(j, 'kind', 'kind');
  const out: IntentGroupCreate = {
    title: title === undefined || title === null ? '' : String(title),
    members: Array.isArray(members) ? members.map((x) => String(x)) : [],
    kind: kind === undefined || kind === null ? '' : String(kind),
  };
  return out;
}

export function intentGroupCreateToJson(m: IntentGroupCreate): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.title === '')) j.title = m.title;
  if (m.members.length) j.members = m.members.map((x) => x);
  if (!(m.kind === '')) j.kind = m.kind;
  return j;
}

export interface IntentGroupJoinByLink {
  url: string;
}

export function intentGroupJoinByLinkFromJson(v: unknown): IntentGroupJoinByLink {
  const j = (v ?? {}) as Record<string, unknown>;
  const url = pick(j, 'url', 'url');
  const out: IntentGroupJoinByLink = {
    url: url === undefined || url === null ? '' : String(url),
  };
  return out;
}

export function intentGroupJoinByLinkToJson(m: IntentGroupJoinByLink): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.url === '')) j.url = m.url;
  return j;
}

export interface IntentPin {
  chat?: Peer;
  target: Uint8Array;
  on: boolean;
}

export function intentPinFromJson(v: unknown): IntentPin {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const target = pick(j, 'target', 'target');
  const on = pick(j, 'on', 'on');
  const out: IntentPin = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    target: target === undefined || target === null ? new Uint8Array(0) : fromBase64(String(target)),
    on: on === undefined || on === null ? false : Boolean(on),
  };
  return out;
}

export function intentPinToJson(m: IntentPin): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.target.length === 0)) j.target = toBase64(m.target);
  if (!(!m.on)) j.on = m.on;
  return j;
}

export interface IntentReact {
  chat?: Peer;
  target: Uint8Array;
  emoji: string;
}

export function intentReactFromJson(v: unknown): IntentReact {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const target = pick(j, 'target', 'target');
  const emoji = pick(j, 'emoji', 'emoji');
  const out: IntentReact = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    target: target === undefined || target === null ? new Uint8Array(0) : fromBase64(String(target)),
    emoji: emoji === undefined || emoji === null ? '' : String(emoji),
  };
  return out;
}

export function intentReactToJson(m: IntentReact): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.target.length === 0)) j.target = toBase64(m.target);
  if (!(m.emoji === '')) j.emoji = m.emoji;
  return j;
}

export interface IntentRead {
  chat?: Peer;
  upTo?: MsgAnchor;
}

export function intentReadFromJson(v: unknown): IntentRead {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const upTo = pick(j, 'up_to', 'upTo');
  const out: IntentRead = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    upTo: upTo === undefined || upTo === null ? undefined : msgAnchorFromJson(upTo),
  };
  return out;
}

export function intentReadToJson(m: IntentRead): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.upTo === undefined)) j.up_to = msgAnchorToJson(m.upTo!);
  return j;
}

export interface IntentRevoke {
  deviceId: string;
  stolen: boolean;
}

export function intentRevokeFromJson(v: unknown): IntentRevoke {
  const j = (v ?? {}) as Record<string, unknown>;
  const deviceId = pick(j, 'device_id', 'deviceId');
  const stolen = pick(j, 'stolen', 'stolen');
  const out: IntentRevoke = {
    deviceId: deviceId === undefined || deviceId === null ? '' : String(deviceId),
    stolen: stolen === undefined || stolen === null ? false : Boolean(stolen),
  };
  return out;
}

export function intentRevokeToJson(m: IntentRevoke): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.deviceId === '')) j.device_id = m.deviceId;
  if (!(!m.stolen)) j.stolen = m.stolen;
  return j;
}

export interface IntentRotateSsk {
  rootSecret: Uint8Array;
}

export function intentRotateSskFromJson(v: unknown): IntentRotateSsk {
  const j = (v ?? {}) as Record<string, unknown>;
  const rootSecret = pick(j, 'root_secret', 'rootSecret');
  const out: IntentRotateSsk = {
    rootSecret: rootSecret === undefined || rootSecret === null ? new Uint8Array(0) : fromBase64(String(rootSecret)),
  };
  return out;
}

export function intentRotateSskToJson(m: IntentRotateSsk): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.rootSecret.length === 0)) j.root_secret = toBase64(m.rootSecret);
  return j;
}

export interface IntentSend {
  chat?: Peer;
  content?: ComposeContent;
  scheduleAtMs: string;
}

export function intentSendFromJson(v: unknown): IntentSend {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const content = pick(j, 'content', 'content');
  const scheduleAtMs = pick(j, 'schedule_at_ms', 'scheduleAtMs');
  const out: IntentSend = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    content: content === undefined || content === null ? undefined : composeContentFromJson(content),
    scheduleAtMs: scheduleAtMs === undefined || scheduleAtMs === null ? '' : String(scheduleAtMs),
  };
  return out;
}

export function intentSendToJson(m: IntentSend): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.content === undefined)) j.content = composeContentToJson(m.content!);
  if (!((m.scheduleAtMs === '' || m.scheduleAtMs === '0'))) j.schedule_at_ms = m.scheduleAtMs;
  return j;
}

export interface IntentStateCreate {
  object?: ObjectKey;
  set: FieldValue[];
}

export function intentStateCreateFromJson(v: unknown): IntentStateCreate {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const set = pick(j, 'set', 'set');
  const out: IntentStateCreate = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
    set: Array.isArray(set) ? set.map((x) => fieldValueFromJson(x)) : [],
  };
  return out;
}

export function intentStateCreateToJson(m: IntentStateCreate): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  if (m.set.length) j.set = m.set.map((x) => fieldValueToJson(x));
  return j;
}

export interface IntentStateDelete {
  object?: ObjectKey;
}

export function intentStateDeleteFromJson(v: unknown): IntentStateDelete {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const out: IntentStateDelete = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
  };
  return out;
}

export function intentStateDeleteToJson(m: IntentStateDelete): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  return j;
}

export interface IntentStatePatch {
  object?: ObjectKey;
  set: FieldValue[];
  clear: number[];
}

export function intentStatePatchFromJson(v: unknown): IntentStatePatch {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const set = pick(j, 'set', 'set');
  const clear = pick(j, 'clear', 'clear');
  const out: IntentStatePatch = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
    set: Array.isArray(set) ? set.map((x) => fieldValueFromJson(x)) : [],
    clear: Array.isArray(clear) ? clear.map((x) => Number(x)) : [],
  };
  return out;
}

export function intentStatePatchToJson(m: IntentStatePatch): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  if (m.set.length) j.set = m.set.map((x) => fieldValueToJson(x));
  if (m.clear.length) j.clear = m.clear.map((x) => x);
  return j;
}

export interface IntentStateSetAdd {
  object?: ObjectKey;
  field: number;
  element: Uint8Array;
}

export function intentStateSetAddFromJson(v: unknown): IntentStateSetAdd {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const field = pick(j, 'field', 'field');
  const element = pick(j, 'element', 'element');
  const out: IntentStateSetAdd = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
    field: field === undefined || field === null ? 0 : Number(field),
    element: element === undefined || element === null ? new Uint8Array(0) : fromBase64(String(element)),
  };
  return out;
}

export function intentStateSetAddToJson(m: IntentStateSetAdd): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  if (!(m.field === 0)) j.field = m.field;
  if (!(m.element.length === 0)) j.element = toBase64(m.element);
  return j;
}

export interface IntentStateSetRemove {
  object?: ObjectKey;
  field: number;
  element: Uint8Array;
}

export function intentStateSetRemoveFromJson(v: unknown): IntentStateSetRemove {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const field = pick(j, 'field', 'field');
  const element = pick(j, 'element', 'element');
  const out: IntentStateSetRemove = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
    field: field === undefined || field === null ? 0 : Number(field),
    element: element === undefined || element === null ? new Uint8Array(0) : fromBase64(String(element)),
  };
  return out;
}

export function intentStateSetRemoveToJson(m: IntentStateSetRemove): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  if (!(m.field === 0)) j.field = m.field;
  if (!(m.element.length === 0)) j.element = toBase64(m.element);
  return j;
}

export interface IntentTyping {
  chat?: Peer;
  action: string;
}

export function intentTypingFromJson(v: unknown): IntentTyping {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const action = pick(j, 'action', 'action');
  const out: IntentTyping = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    action: action === undefined || action === null ? '' : String(action),
  };
  return out;
}

export function intentTypingToJson(m: IntentTyping): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.action === '')) j.action = m.action;
  return j;
}

export interface JournalState {
  journal: string;
  cursor: string;
  head: string;
  write: JournalWrite;
}

export function journalStateFromJson(v: unknown): JournalState {
  const j = (v ?? {}) as Record<string, unknown>;
  const journal = pick(j, 'journal', 'journal');
  const cursor = pick(j, 'cursor', 'cursor');
  const head = pick(j, 'head', 'head');
  const write = pick(j, 'write', 'write');
  const out: JournalState = {
    journal: journal === undefined || journal === null ? '' : String(journal),
    cursor: cursor === undefined || cursor === null ? '' : String(cursor),
    head: head === undefined || head === null ? '' : String(head),
    write: write === undefined || write === null ? JournalWriteValues[0] : journalWriteFromJson(write),
  };
  return out;
}

export function journalStateToJson(m: JournalState): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.journal === '')) j.journal = m.journal;
  if (!((m.cursor === '' || m.cursor === '0'))) j.cursor = m.cursor;
  if (!((m.head === '' || m.head === '0'))) j.head = m.head;
  if (!(m.write === JournalWriteValues[0])) j.write = m.write;
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

export interface LegacyRecord {
  key: string;
  value: Uint8Array;
}

export function legacyRecordFromJson(v: unknown): LegacyRecord {
  const j = (v ?? {}) as Record<string, unknown>;
  const key = pick(j, 'key', 'key');
  const value = pick(j, 'value', 'value');
  const out: LegacyRecord = {
    key: key === undefined || key === null ? '' : String(key),
    value: value === undefined || value === null ? new Uint8Array(0) : fromBase64(String(value)),
  };
  return out;
}

export function legacyRecordToJson(m: LegacyRecord): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.key === '')) j.key = m.key;
  if (!(m.value.length === 0)) j.value = toBase64(m.value);
  return j;
}

export interface MarkValue {
  field: number;
  value: Uint8Array;
}

export function markValueFromJson(v: unknown): MarkValue {
  const j = (v ?? {}) as Record<string, unknown>;
  const field = pick(j, 'field', 'field');
  const value = pick(j, 'value', 'value');
  const out: MarkValue = {
    field: field === undefined || field === null ? 0 : Number(field),
    value: value === undefined || value === null ? new Uint8Array(0) : fromBase64(String(value)),
  };
  return out;
}

export function markValueToJson(m: MarkValue): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.field === 0)) j.field = m.field;
  if (!(m.value.length === 0)) j.value = toBase64(m.value);
  return j;
}

export interface MessageRemove {
  chat?: Peer;
  id: Uint8Array;
}

export function messageRemoveFromJson(v: unknown): MessageRemove {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const id = pick(j, 'id', 'id');
  const out: MessageRemove = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    id: id === undefined || id === null ? new Uint8Array(0) : fromBase64(String(id)),
  };
  return out;
}

export function messageRemoveToJson(m: MessageRemove): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.id.length === 0)) j.id = toBase64(m.id);
  return j;
}

export interface MessageView {
  id: Uint8Array;
  chat?: Peer;
  from: string;
  tsMs: string;
  editedTsMs: string;
  outgoing: boolean;
  disposition: Disposition;
  body?: ViewBody;
  replyTo: Uint8Array;
  forwardFrom: string;
  reactions: ViewReaction[];
  pinned: boolean;
  ttlSecs: number;
  delivery: Delivery;
  forwardName: string;
  replyQuote?: ViewText;
  silent: boolean;
  order: string;
  wire: string;
}

export function messageViewFromJson(v: unknown): MessageView {
  const j = (v ?? {}) as Record<string, unknown>;
  const id = pick(j, 'id', 'id');
  const chat = pick(j, 'chat', 'chat');
  const from = pick(j, 'from', 'from');
  const tsMs = pick(j, 'ts_ms', 'tsMs');
  const editedTsMs = pick(j, 'edited_ts_ms', 'editedTsMs');
  const outgoing = pick(j, 'outgoing', 'outgoing');
  const disposition = pick(j, 'disposition', 'disposition');
  const body = pick(j, 'body', 'body');
  const replyTo = pick(j, 'reply_to', 'replyTo');
  const forwardFrom = pick(j, 'forward_from', 'forwardFrom');
  const reactions = pick(j, 'reactions', 'reactions');
  const pinned = pick(j, 'pinned', 'pinned');
  const ttlSecs = pick(j, 'ttl_secs', 'ttlSecs');
  const delivery = pick(j, 'delivery', 'delivery');
  const forwardName = pick(j, 'forward_name', 'forwardName');
  const replyQuote = pick(j, 'reply_quote', 'replyQuote');
  const silent = pick(j, 'silent', 'silent');
  const order = pick(j, 'order', 'order');
  const wire = pick(j, 'wire', 'wire');
  const out: MessageView = {
    id: id === undefined || id === null ? new Uint8Array(0) : fromBase64(String(id)),
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    from: from === undefined || from === null ? '' : String(from),
    tsMs: tsMs === undefined || tsMs === null ? '' : String(tsMs),
    editedTsMs: editedTsMs === undefined || editedTsMs === null ? '' : String(editedTsMs),
    outgoing: outgoing === undefined || outgoing === null ? false : Boolean(outgoing),
    disposition: disposition === undefined || disposition === null ? DispositionValues[0] : dispositionFromJson(disposition),
    body: body === undefined || body === null ? undefined : viewBodyFromJson(body),
    replyTo: replyTo === undefined || replyTo === null ? new Uint8Array(0) : fromBase64(String(replyTo)),
    forwardFrom: forwardFrom === undefined || forwardFrom === null ? '' : String(forwardFrom),
    reactions: Array.isArray(reactions) ? reactions.map((x) => viewReactionFromJson(x)) : [],
    pinned: pinned === undefined || pinned === null ? false : Boolean(pinned),
    ttlSecs: ttlSecs === undefined || ttlSecs === null ? 0 : Number(ttlSecs),
    delivery: delivery === undefined || delivery === null ? DeliveryValues[0] : deliveryFromJson(delivery),
    forwardName: forwardName === undefined || forwardName === null ? '' : String(forwardName),
    replyQuote: replyQuote === undefined || replyQuote === null ? undefined : viewTextFromJson(replyQuote),
    silent: silent === undefined || silent === null ? false : Boolean(silent),
    order: order === undefined || order === null ? '' : String(order),
    wire: wire === undefined || wire === null ? '' : String(wire),
  };
  return out;
}

export function messageViewToJson(m: MessageView): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.id.length === 0)) j.id = toBase64(m.id);
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.from === '')) j.from = m.from;
  if (!((m.tsMs === '' || m.tsMs === '0'))) j.ts_ms = m.tsMs;
  if (!((m.editedTsMs === '' || m.editedTsMs === '0'))) j.edited_ts_ms = m.editedTsMs;
  if (!(!m.outgoing)) j.outgoing = m.outgoing;
  if (!(m.disposition === DispositionValues[0])) j.disposition = m.disposition;
  if (!(m.body === undefined)) j.body = viewBodyToJson(m.body!);
  if (!(m.replyTo.length === 0)) j.reply_to = toBase64(m.replyTo);
  if (!(m.forwardFrom === '')) j.forward_from = m.forwardFrom;
  if (m.reactions.length) j.reactions = m.reactions.map((x) => viewReactionToJson(x));
  if (!(!m.pinned)) j.pinned = m.pinned;
  if (!(m.ttlSecs === 0)) j.ttl_secs = m.ttlSecs;
  if (!(m.delivery === DeliveryValues[0])) j.delivery = m.delivery;
  if (!(m.forwardName === '')) j.forward_name = m.forwardName;
  if (!(m.replyQuote === undefined)) j.reply_quote = viewTextToJson(m.replyQuote!);
  if (!(!m.silent)) j.silent = m.silent;
  if (!((m.order === '' || m.order === '0'))) j.order = m.order;
  if (!(m.wire === '')) j.wire = m.wire;
  return j;
}

export interface MigrateStatus {
  point: number;
  done: boolean;
  reportJson: string;
}

export function migrateStatusFromJson(v: unknown): MigrateStatus {
  const j = (v ?? {}) as Record<string, unknown>;
  const point = pick(j, 'point', 'point');
  const done = pick(j, 'done', 'done');
  const reportJson = pick(j, 'report_json', 'reportJson');
  const out: MigrateStatus = {
    point: point === undefined || point === null ? 0 : Number(point),
    done: done === undefined || done === null ? false : Boolean(done),
    reportJson: reportJson === undefined || reportJson === null ? '' : String(reportJson),
  };
  return out;
}

export function migrateStatusToJson(m: MigrateStatus): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.point === 0)) j.point = m.point;
  if (!(!m.done)) j.done = m.done;
  if (!(m.reportJson === '')) j.report_json = m.reportJson;
  return j;
}

export interface MigrateStep {
  layer: string;
  records: LegacyRecord[];
  last: boolean;
  chunk: number;
}

export function migrateStepFromJson(v: unknown): MigrateStep {
  const j = (v ?? {}) as Record<string, unknown>;
  const layer = pick(j, 'layer', 'layer');
  const records = pick(j, 'records', 'records');
  const last = pick(j, 'last', 'last');
  const chunk = pick(j, 'chunk', 'chunk');
  const out: MigrateStep = {
    layer: layer === undefined || layer === null ? '' : String(layer),
    records: Array.isArray(records) ? records.map((x) => legacyRecordFromJson(x)) : [],
    last: last === undefined || last === null ? false : Boolean(last),
    chunk: chunk === undefined || chunk === null ? 0 : Number(chunk),
  };
  return out;
}

export function migrateStepToJson(m: MigrateStep): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.layer === '')) j.layer = m.layer;
  if (m.records.length) j.records = m.records.map((x) => legacyRecordToJson(x));
  if (!(!m.last)) j.last = m.last;
  if (!(m.chunk === 0)) j.chunk = m.chunk;
  return j;
}

export interface MigrationPlan {
  steps: string[];
  legacyRecords: string;
}

export function migrationPlanFromJson(v: unknown): MigrationPlan {
  const j = (v ?? {}) as Record<string, unknown>;
  const steps = pick(j, 'steps', 'steps');
  const legacyRecords = pick(j, 'legacy_records', 'legacyRecords');
  const out: MigrationPlan = {
    steps: Array.isArray(steps) ? steps.map((x) => String(x)) : [],
    legacyRecords: legacyRecords === undefined || legacyRecords === null ? '' : String(legacyRecords),
  };
  return out;
}

export function migrationPlanToJson(m: MigrationPlan): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.steps.length) j.steps = m.steps.map((x) => x);
  if (!((m.legacyRecords === '' || m.legacyRecords === '0'))) j.legacy_records = m.legacyRecords;
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

export interface ModelChange {
  change?: { case: 'chatUpsert'; value: ChatView } | { case: 'chatRemove'; value: Peer } | { case: 'messageUpsert'; value: MessageView } | { case: 'messageRemove'; value: MessageRemove } | { case: 'stateChanged'; value: StateChanged } | { case: 'groupChanged'; value: GroupView } | { case: 'notice'; value: Notice } | { case: 'unreadChanged'; value: UnreadChanged } | { case: 'writeBlocked'; value: WriteBlocked } | { case: 'needs'; value: Need } | { case: 'clientEvents'; value: ClientEvents };
}

export function modelChangeFromJson(v: unknown): ModelChange {
  const j = (v ?? {}) as Record<string, unknown>;
  const out: ModelChange = {
  };
  {
    const x = pick(j, 'chat_upsert', 'chatUpsert');
    if (x !== undefined && x !== null) out.change = { case: 'chatUpsert', value: chatViewFromJson(x) };
  }
  {
    const x = pick(j, 'chat_remove', 'chatRemove');
    if (x !== undefined && x !== null) out.change = { case: 'chatRemove', value: peerFromJson(x) };
  }
  {
    const x = pick(j, 'message_upsert', 'messageUpsert');
    if (x !== undefined && x !== null) out.change = { case: 'messageUpsert', value: messageViewFromJson(x) };
  }
  {
    const x = pick(j, 'message_remove', 'messageRemove');
    if (x !== undefined && x !== null) out.change = { case: 'messageRemove', value: messageRemoveFromJson(x) };
  }
  {
    const x = pick(j, 'state_changed', 'stateChanged');
    if (x !== undefined && x !== null) out.change = { case: 'stateChanged', value: stateChangedFromJson(x) };
  }
  {
    const x = pick(j, 'group_changed', 'groupChanged');
    if (x !== undefined && x !== null) out.change = { case: 'groupChanged', value: groupViewFromJson(x) };
  }
  {
    const x = pick(j, 'notice', 'notice');
    if (x !== undefined && x !== null) out.change = { case: 'notice', value: noticeFromJson(x) };
  }
  {
    const x = pick(j, 'unread_changed', 'unreadChanged');
    if (x !== undefined && x !== null) out.change = { case: 'unreadChanged', value: unreadChangedFromJson(x) };
  }
  {
    const x = pick(j, 'write_blocked', 'writeBlocked');
    if (x !== undefined && x !== null) out.change = { case: 'writeBlocked', value: writeBlockedFromJson(x) };
  }
  {
    const x = pick(j, 'needs', 'needs');
    if (x !== undefined && x !== null) out.change = { case: 'needs', value: needFromJson(x) };
  }
  {
    const x = pick(j, 'client_events', 'clientEvents');
    if (x !== undefined && x !== null) out.change = { case: 'clientEvents', value: clientEventsFromJson(x) };
  }
  return out;
}

export function modelChangeToJson(m: ModelChange): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.change?.case === 'chatUpsert') j.chat_upsert = chatViewToJson(m.change.value);
  if (m.change?.case === 'chatRemove') j.chat_remove = peerToJson(m.change.value);
  if (m.change?.case === 'messageUpsert') j.message_upsert = messageViewToJson(m.change.value);
  if (m.change?.case === 'messageRemove') j.message_remove = messageRemoveToJson(m.change.value);
  if (m.change?.case === 'stateChanged') j.state_changed = stateChangedToJson(m.change.value);
  if (m.change?.case === 'groupChanged') j.group_changed = groupViewToJson(m.change.value);
  if (m.change?.case === 'notice') j.notice = noticeToJson(m.change.value);
  if (m.change?.case === 'unreadChanged') j.unread_changed = unreadChangedToJson(m.change.value);
  if (m.change?.case === 'writeBlocked') j.write_blocked = writeBlockedToJson(m.change.value);
  if (m.change?.case === 'needs') j.needs = needToJson(m.change.value);
  if (m.change?.case === 'clientEvents') j.client_events = clientEventsToJson(m.change.value);
  return j;
}

export interface ModelDelta {
  revision: string;
  changes: ModelChange[];
}

export function modelDeltaFromJson(v: unknown): ModelDelta {
  const j = (v ?? {}) as Record<string, unknown>;
  const revision = pick(j, 'revision', 'revision');
  const changes = pick(j, 'changes', 'changes');
  const out: ModelDelta = {
    revision: revision === undefined || revision === null ? '' : String(revision),
    changes: Array.isArray(changes) ? changes.map((x) => modelChangeFromJson(x)) : [],
  };
  return out;
}

export function modelDeltaToJson(m: ModelDelta): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.revision === '' || m.revision === '0'))) j.revision = m.revision;
  if (m.changes.length) j.changes = m.changes.map((x) => modelChangeToJson(x));
  return j;
}

export interface MsgAnchor {
  tsMs: string;
  id: Uint8Array;
}

export function msgAnchorFromJson(v: unknown): MsgAnchor {
  const j = (v ?? {}) as Record<string, unknown>;
  const tsMs = pick(j, 'ts_ms', 'tsMs');
  const id = pick(j, 'id', 'id');
  const out: MsgAnchor = {
    tsMs: tsMs === undefined || tsMs === null ? '' : String(tsMs),
    id: id === undefined || id === null ? new Uint8Array(0) : fromBase64(String(id)),
  };
  return out;
}

export function msgAnchorToJson(m: MsgAnchor): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.tsMs === '' || m.tsMs === '0'))) j.ts_ms = m.tsMs;
  if (!(m.id.length === 0)) j.id = toBase64(m.id);
  return j;
}

export interface Need {
  kind: string;
  chat?: Peer;
  detail: string;
}

export function needFromJson(v: unknown): Need {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const chat = pick(j, 'chat', 'chat');
  const detail = pick(j, 'detail', 'detail');
  const out: Need = {
    kind: kind === undefined || kind === null ? '' : String(kind),
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    detail: detail === undefined || detail === null ? '' : String(detail),
  };
  return out;
}

export function needToJson(m: Need): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.detail === '')) j.detail = m.detail;
  return j;
}

export interface Notice {
  chat?: Peer;
  kind: string;
  detail: string;
}

export function noticeFromJson(v: unknown): Notice {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const kind = pick(j, 'kind', 'kind');
  const detail = pick(j, 'detail', 'detail');
  const out: Notice = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    kind: kind === undefined || kind === null ? '' : String(kind),
    detail: detail === undefined || detail === null ? '' : String(detail),
  };
  return out;
}

export function noticeToJson(m: Notice): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.detail === '')) j.detail = m.detail;
  return j;
}

export interface ObjectKey {
  kind: ObjectKind;
  key: string;
}

export function objectKeyFromJson(v: unknown): ObjectKey {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const key = pick(j, 'key', 'key');
  const out: ObjectKey = {
    kind: kind === undefined || kind === null ? ObjectKindValues[0] : objectKindFromJson(kind),
    key: key === undefined || key === null ? '' : String(key),
  };
  return out;
}

export function objectKeyToJson(m: ObjectKey): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === ObjectKindValues[0])) j.kind = m.kind;
  if (!(m.key === '')) j.key = m.key;
  return j;
}

export interface OpenResult {
  state: OpenState;
  migration?: MigrationPlan;
}

export function openResultFromJson(v: unknown): OpenResult {
  const j = (v ?? {}) as Record<string, unknown>;
  const state = pick(j, 'state', 'state');
  const migration = pick(j, 'migration', 'migration');
  const out: OpenResult = {
    state: state === undefined || state === null ? OpenStateValues[0] : openStateFromJson(state),
    migration: migration === undefined || migration === null ? undefined : migrationPlanFromJson(migration),
  };
  return out;
}

export function openResultToJson(m: OpenResult): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.state === OpenStateValues[0])) j.state = m.state;
  if (!(m.migration === undefined)) j.migration = migrationPlanToJson(m.migration!);
  return j;
}

export interface OutRequest {
  reqId: string;
  method: string;
  channel: RequestChannel;
  body: Uint8Array;
  deadlineMs: string;
  destDomain: string;
}

export function outRequestFromJson(v: unknown): OutRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const reqId = pick(j, 'req_id', 'reqId');
  const method = pick(j, 'method', 'method');
  const channel = pick(j, 'channel', 'channel');
  const body = pick(j, 'body', 'body');
  const deadlineMs = pick(j, 'deadline_ms', 'deadlineMs');
  const destDomain = pick(j, 'dest_domain', 'destDomain');
  const out: OutRequest = {
    reqId: reqId === undefined || reqId === null ? '' : String(reqId),
    method: method === undefined || method === null ? '' : String(method),
    channel: channel === undefined || channel === null ? RequestChannelValues[0] : requestChannelFromJson(channel),
    body: body === undefined || body === null ? new Uint8Array(0) : fromBase64(String(body)),
    deadlineMs: deadlineMs === undefined || deadlineMs === null ? '' : String(deadlineMs),
    destDomain: destDomain === undefined || destDomain === null ? '' : String(destDomain),
  };
  return out;
}

export function outRequestToJson(m: OutRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.reqId === '' || m.reqId === '0'))) j.req_id = m.reqId;
  if (!(m.method === '')) j.method = m.method;
  if (!(m.channel === RequestChannelValues[0])) j.channel = m.channel;
  if (!(m.body.length === 0)) j.body = toBase64(m.body);
  if (!((m.deadlineMs === '' || m.deadlineMs === '0'))) j.deadline_ms = m.deadlineMs;
  if (!(m.destDomain === '')) j.dest_domain = m.destDomain;
  return j;
}

export interface Outcome {
  storeBatch?: StoreBatch;
  storeReads: StoreReads[];
  requests: OutRequest[];
  delta?: ModelDelta;
  open?: OpenResult;
}

export function outcomeFromJson(v: unknown): Outcome {
  const j = (v ?? {}) as Record<string, unknown>;
  const storeBatch = pick(j, 'store_batch', 'storeBatch');
  const storeReads = pick(j, 'store_reads', 'storeReads');
  const requests = pick(j, 'requests', 'requests');
  const delta = pick(j, 'delta', 'delta');
  const open = pick(j, 'open', 'open');
  const out: Outcome = {
    storeBatch: storeBatch === undefined || storeBatch === null ? undefined : storeBatchFromJson(storeBatch),
    storeReads: Array.isArray(storeReads) ? storeReads.map((x) => storeReadsFromJson(x)) : [],
    requests: Array.isArray(requests) ? requests.map((x) => outRequestFromJson(x)) : [],
    delta: delta === undefined || delta === null ? undefined : modelDeltaFromJson(delta),
    open: open === undefined || open === null ? undefined : openResultFromJson(open),
  };
  return out;
}

export function outcomeToJson(m: Outcome): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.storeBatch === undefined)) j.store_batch = storeBatchToJson(m.storeBatch!);
  if (m.storeReads.length) j.store_reads = m.storeReads.map((x) => storeReadsToJson(x));
  if (m.requests.length) j.requests = m.requests.map((x) => outRequestToJson(x));
  if (!(m.delta === undefined)) j.delta = modelDeltaToJson(m.delta!);
  if (!(m.open === undefined)) j.open = openResultToJson(m.open!);
  return j;
}

export interface Peer {
  kind?: { case: 'user'; value: UserRef } | { case: 'group'; value: Ref };
}

export function peerFromJson(v: unknown): Peer {
  const j = (v ?? {}) as Record<string, unknown>;
  const out: Peer = {
  };
  {
    const x = pick(j, 'user', 'user');
    if (x !== undefined && x !== null) out.kind = { case: 'user', value: userRefFromJson(x) };
  }
  {
    const x = pick(j, 'group', 'group');
    if (x !== undefined && x !== null) out.kind = { case: 'group', value: refFromJson(x) };
  }
  return out;
}

export function peerToJson(m: Peer): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.kind?.case === 'user') j.user = userRefToJson(m.kind.value);
  if (m.kind?.case === 'group') j.group = refToJson(m.kind.value);
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

export interface RangeHold {
  journal: string;
  fromSeq: string;
  toSeq: string;
  paths: string[];
}

export function rangeHoldFromJson(v: unknown): RangeHold {
  const j = (v ?? {}) as Record<string, unknown>;
  const journal = pick(j, 'journal', 'journal');
  const fromSeq = pick(j, 'from_seq', 'fromSeq');
  const toSeq = pick(j, 'to_seq', 'toSeq');
  const paths = pick(j, 'paths', 'paths');
  const out: RangeHold = {
    journal: journal === undefined || journal === null ? '' : String(journal),
    fromSeq: fromSeq === undefined || fromSeq === null ? '' : String(fromSeq),
    toSeq: toSeq === undefined || toSeq === null ? '' : String(toSeq),
    paths: Array.isArray(paths) ? paths.map((x) => String(x)) : [],
  };
  return out;
}

export function rangeHoldToJson(m: RangeHold): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.journal === '')) j.journal = m.journal;
  if (!((m.fromSeq === '' || m.fromSeq === '0'))) j.from_seq = m.fromSeq;
  if (!((m.toSeq === '' || m.toSeq === '0'))) j.to_seq = m.toSeq;
  if (m.paths.length) j.paths = m.paths.map((x) => x);
  return j;
}

export interface RangeHolds {
  holds: RangeHold[];
}

export function rangeHoldsFromJson(v: unknown): RangeHolds {
  const j = (v ?? {}) as Record<string, unknown>;
  const holds = pick(j, 'holds', 'holds');
  const out: RangeHolds = {
    holds: Array.isArray(holds) ? holds.map((x) => rangeHoldFromJson(x)) : [],
  };
  return out;
}

export function rangeHoldsToJson(m: RangeHolds): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.holds.length) j.holds = m.holds.map((x) => rangeHoldToJson(x));
  return j;
}

export interface Ref {
  domain: string;
  id: Uint8Array;
}

export function refFromJson(v: unknown): Ref {
  const j = (v ?? {}) as Record<string, unknown>;
  const domain = pick(j, 'domain', 'domain');
  const id = pick(j, 'id', 'id');
  const out: Ref = {
    domain: domain === undefined || domain === null ? '' : String(domain),
    id: id === undefined || id === null ? new Uint8Array(0) : fromBase64(String(id)),
  };
  return out;
}

export function refToJson(m: Ref): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.domain === '')) j.domain = m.domain;
  if (!(m.id.length === 0)) j.id = toBase64(m.id);
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

export interface RowsAllRequest {
  views: boolean;
  states: boolean;
  marks: boolean;
}

export function rowsAllRequestFromJson(v: unknown): RowsAllRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const views = pick(j, 'views', 'views');
  const states = pick(j, 'states', 'states');
  const marks = pick(j, 'marks', 'marks');
  const out: RowsAllRequest = {
    views: views === undefined || views === null ? false : Boolean(views),
    states: states === undefined || states === null ? false : Boolean(states),
    marks: marks === undefined || marks === null ? false : Boolean(marks),
  };
  return out;
}

export function rowsAllRequestToJson(m: RowsAllRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(!m.views)) j.views = m.views;
  if (!(!m.states)) j.states = m.states;
  if (!(!m.marks)) j.marks = m.marks;
  return j;
}

export interface RowsApply {
  opsJson: string;
  receiptsJson: string;
  forgetJson: string;
  wipe: boolean;
  nowMs: string;
  rowsJson: string;
}

export function rowsApplyFromJson(v: unknown): RowsApply {
  const j = (v ?? {}) as Record<string, unknown>;
  const opsJson = pick(j, 'ops_json', 'opsJson');
  const receiptsJson = pick(j, 'receipts_json', 'receiptsJson');
  const forgetJson = pick(j, 'forget_json', 'forgetJson');
  const wipe = pick(j, 'wipe', 'wipe');
  const nowMs = pick(j, 'now_ms', 'nowMs');
  const rowsJson = pick(j, 'rows_json', 'rowsJson');
  const out: RowsApply = {
    opsJson: opsJson === undefined || opsJson === null ? '' : String(opsJson),
    receiptsJson: receiptsJson === undefined || receiptsJson === null ? '' : String(receiptsJson),
    forgetJson: forgetJson === undefined || forgetJson === null ? '' : String(forgetJson),
    wipe: wipe === undefined || wipe === null ? false : Boolean(wipe),
    nowMs: nowMs === undefined || nowMs === null ? '' : String(nowMs),
    rowsJson: rowsJson === undefined || rowsJson === null ? '' : String(rowsJson),
  };
  return out;
}

export function rowsApplyToJson(m: RowsApply): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.opsJson === '')) j.ops_json = m.opsJson;
  if (!(m.receiptsJson === '')) j.receipts_json = m.receiptsJson;
  if (!(m.forgetJson === '')) j.forget_json = m.forgetJson;
  if (!(!m.wipe)) j.wipe = m.wipe;
  if (!((m.nowMs === '' || m.nowMs === '0'))) j.now_ms = m.nowMs;
  if (!(m.rowsJson === '')) j.rows_json = m.rowsJson;
  return j;
}

export interface ServerInput {
  kind: ServerInputKind;
  method: string;
  reqId: string;
  body: Uint8Array;
  error: number;
}

export function serverInputFromJson(v: unknown): ServerInput {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const method = pick(j, 'method', 'method');
  const reqId = pick(j, 'req_id', 'reqId');
  const body = pick(j, 'body', 'body');
  const error = pick(j, 'error', 'error');
  const out: ServerInput = {
    kind: kind === undefined || kind === null ? ServerInputKindValues[0] : serverInputKindFromJson(kind),
    method: method === undefined || method === null ? '' : String(method),
    reqId: reqId === undefined || reqId === null ? '' : String(reqId),
    body: body === undefined || body === null ? new Uint8Array(0) : fromBase64(String(body)),
    error: error === undefined || error === null ? 0 : Number(error),
  };
  return out;
}

export function serverInputToJson(m: ServerInput): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === ServerInputKindValues[0])) j.kind = m.kind;
  if (!(m.method === '')) j.method = m.method;
  if (!((m.reqId === '' || m.reqId === '0'))) j.req_id = m.reqId;
  if (!(m.body.length === 0)) j.body = toBase64(m.body);
  if (!(m.error === 0)) j.error = m.error;
  return j;
}

export interface StateChanged {
  object?: ObjectKey;
  view?: StateObjectView;
}

export function stateChangedFromJson(v: unknown): StateChanged {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const view = pick(j, 'view', 'view');
  const out: StateChanged = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
    view: view === undefined || view === null ? undefined : stateObjectViewFromJson(view),
  };
  return out;
}

export function stateChangedToJson(m: StateChanged): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  if (!(m.view === undefined)) j.view = stateObjectViewToJson(m.view!);
  return j;
}

export interface StateObjectView {
  object?: ObjectKey;
  fields: FieldValue[];
  marks: MarkValue[];
}

export function stateObjectViewFromJson(v: unknown): StateObjectView {
  const j = (v ?? {}) as Record<string, unknown>;
  const object = pick(j, 'object', 'object');
  const fields = pick(j, 'fields', 'fields');
  const marks = pick(j, 'marks', 'marks');
  const out: StateObjectView = {
    object: object === undefined || object === null ? undefined : objectKeyFromJson(object),
    fields: Array.isArray(fields) ? fields.map((x) => fieldValueFromJson(x)) : [],
    marks: Array.isArray(marks) ? marks.map((x) => markValueFromJson(x)) : [],
  };
  return out;
}

export function stateObjectViewToJson(m: StateObjectView): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.object === undefined)) j.object = objectKeyToJson(m.object!);
  if (m.fields.length) j.fields = m.fields.map((x) => fieldValueToJson(x));
  if (m.marks.length) j.marks = m.marks.map((x) => markValueToJson(x));
  return j;
}

export interface StateView {
  objects: StateObjectView[];
}

export function stateViewFromJson(v: unknown): StateView {
  const j = (v ?? {}) as Record<string, unknown>;
  const objects = pick(j, 'objects', 'objects');
  const out: StateView = {
    objects: Array.isArray(objects) ? objects.map((x) => stateObjectViewFromJson(x)) : [],
  };
  return out;
}

export function stateViewToJson(m: StateView): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.objects.length) j.objects = m.objects.map((x) => stateObjectViewToJson(x));
  return j;
}

export interface StorageFormat {
  kind: string;
  format: number;
}

export function storageFormatFromJson(v: unknown): StorageFormat {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const format = pick(j, 'format', 'format');
  const out: StorageFormat = {
    kind: kind === undefined || kind === null ? '' : String(kind),
    format: format === undefined || format === null ? 0 : Number(format),
  };
  return out;
}

export function storageFormatToJson(m: StorageFormat): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.format === 0)) j.format = m.format;
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

export interface StoreCommitted {
  batchId: string;
}

export function storeCommittedFromJson(v: unknown): StoreCommitted {
  const j = (v ?? {}) as Record<string, unknown>;
  const batchId = pick(j, 'batch_id', 'batchId');
  const out: StoreCommitted = {
    batchId: batchId === undefined || batchId === null ? '' : String(batchId),
  };
  return out;
}

export function storeCommittedToJson(m: StoreCommitted): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.batchId === '' || m.batchId === '0'))) j.batch_id = m.batchId;
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

export interface Tick {
  nowMs: string;
}

export function tickFromJson(v: unknown): Tick {
  const j = (v ?? {}) as Record<string, unknown>;
  const nowMs = pick(j, 'now_ms', 'nowMs');
  const out: Tick = {
    nowMs: nowMs === undefined || nowMs === null ? '' : String(nowMs),
  };
  return out;
}

export function tickToJson(m: Tick): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!((m.nowMs === '' || m.nowMs === '0'))) j.now_ms = m.nowMs;
  return j;
}

export interface UnlockPin {
  pin: string;
}

export function unlockPinFromJson(v: unknown): UnlockPin {
  const j = (v ?? {}) as Record<string, unknown>;
  const pin = pick(j, 'pin', 'pin');
  const out: UnlockPin = {
    pin: pin === undefined || pin === null ? '' : String(pin),
  };
  return out;
}

export function unlockPinToJson(m: UnlockPin): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.pin === '')) j.pin = m.pin;
  return j;
}

export interface UnreadChanged {
  chat?: Peer;
  count: number;
  mention: boolean;
}

export function unreadChangedFromJson(v: unknown): UnreadChanged {
  const j = (v ?? {}) as Record<string, unknown>;
  const chat = pick(j, 'chat', 'chat');
  const count = pick(j, 'count', 'count');
  const mention = pick(j, 'mention', 'mention');
  const out: UnreadChanged = {
    chat: chat === undefined || chat === null ? undefined : peerFromJson(chat),
    count: count === undefined || count === null ? 0 : Number(count),
    mention: mention === undefined || mention === null ? false : Boolean(mention),
  };
  return out;
}

export function unreadChangedToJson(m: UnreadChanged): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.chat === undefined)) j.chat = peerToJson(m.chat!);
  if (!(m.count === 0)) j.count = m.count;
  if (!(!m.mention)) j.mention = m.mention;
  return j;
}

export interface UserRef {
  address: string;
}

export function userRefFromJson(v: unknown): UserRef {
  const j = (v ?? {}) as Record<string, unknown>;
  const address = pick(j, 'address', 'address');
  const out: UserRef = {
    address: address === undefined || address === null ? '' : String(address),
  };
  return out;
}

export function userRefToJson(m: UserRef): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.address === '')) j.address = m.address;
  return j;
}

export interface ViewArticle {
  title: string;
  markdown: string;
}

export function viewArticleFromJson(v: unknown): ViewArticle {
  const j = (v ?? {}) as Record<string, unknown>;
  const title = pick(j, 'title', 'title');
  const markdown = pick(j, 'markdown', 'markdown');
  const out: ViewArticle = {
    title: title === undefined || title === null ? '' : String(title),
    markdown: markdown === undefined || markdown === null ? '' : String(markdown),
  };
  return out;
}

export function viewArticleToJson(m: ViewArticle): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.title === '')) j.title = m.title;
  if (!(m.markdown === '')) j.markdown = m.markdown;
  return j;
}

export interface ViewBody {
  kind?: { case: 'text'; value: ViewText } | { case: 'media'; value: ViewMedia } | { case: 'sticker'; value: ViewSticker } | { case: 'poll'; value: ViewPoll } | { case: 'location'; value: ViewLocation } | { case: 'contact'; value: ViewContact } | { case: 'call'; value: ViewCall } | { case: 'taskOffer'; value: ViewTaskOffer } | { case: 'article'; value: ViewArticle } | { case: 'cloudInvite'; value: ViewCloudInvite } | { case: 'service'; value: ViewService };
}

export function viewBodyFromJson(v: unknown): ViewBody {
  const j = (v ?? {}) as Record<string, unknown>;
  const out: ViewBody = {
  };
  {
    const x = pick(j, 'text', 'text');
    if (x !== undefined && x !== null) out.kind = { case: 'text', value: viewTextFromJson(x) };
  }
  {
    const x = pick(j, 'media', 'media');
    if (x !== undefined && x !== null) out.kind = { case: 'media', value: viewMediaFromJson(x) };
  }
  {
    const x = pick(j, 'sticker', 'sticker');
    if (x !== undefined && x !== null) out.kind = { case: 'sticker', value: viewStickerFromJson(x) };
  }
  {
    const x = pick(j, 'poll', 'poll');
    if (x !== undefined && x !== null) out.kind = { case: 'poll', value: viewPollFromJson(x) };
  }
  {
    const x = pick(j, 'location', 'location');
    if (x !== undefined && x !== null) out.kind = { case: 'location', value: viewLocationFromJson(x) };
  }
  {
    const x = pick(j, 'contact', 'contact');
    if (x !== undefined && x !== null) out.kind = { case: 'contact', value: viewContactFromJson(x) };
  }
  {
    const x = pick(j, 'call', 'call');
    if (x !== undefined && x !== null) out.kind = { case: 'call', value: viewCallFromJson(x) };
  }
  {
    const x = pick(j, 'task_offer', 'taskOffer');
    if (x !== undefined && x !== null) out.kind = { case: 'taskOffer', value: viewTaskOfferFromJson(x) };
  }
  {
    const x = pick(j, 'article', 'article');
    if (x !== undefined && x !== null) out.kind = { case: 'article', value: viewArticleFromJson(x) };
  }
  {
    const x = pick(j, 'cloud_invite', 'cloudInvite');
    if (x !== undefined && x !== null) out.kind = { case: 'cloudInvite', value: viewCloudInviteFromJson(x) };
  }
  {
    const x = pick(j, 'service', 'service');
    if (x !== undefined && x !== null) out.kind = { case: 'service', value: viewServiceFromJson(x) };
  }
  return out;
}

export function viewBodyToJson(m: ViewBody): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.kind?.case === 'text') j.text = viewTextToJson(m.kind.value);
  if (m.kind?.case === 'media') j.media = viewMediaToJson(m.kind.value);
  if (m.kind?.case === 'sticker') j.sticker = viewStickerToJson(m.kind.value);
  if (m.kind?.case === 'poll') j.poll = viewPollToJson(m.kind.value);
  if (m.kind?.case === 'location') j.location = viewLocationToJson(m.kind.value);
  if (m.kind?.case === 'contact') j.contact = viewContactToJson(m.kind.value);
  if (m.kind?.case === 'call') j.call = viewCallToJson(m.kind.value);
  if (m.kind?.case === 'taskOffer') j.task_offer = viewTaskOfferToJson(m.kind.value);
  if (m.kind?.case === 'article') j.article = viewArticleToJson(m.kind.value);
  if (m.kind?.case === 'cloudInvite') j.cloud_invite = viewCloudInviteToJson(m.kind.value);
  if (m.kind?.case === 'service') j.service = viewServiceToJson(m.kind.value);
  return j;
}

export interface ViewCall {
  video: boolean;
  outgoing: boolean;
  durationS: number;
  reason: string;
}

export function viewCallFromJson(v: unknown): ViewCall {
  const j = (v ?? {}) as Record<string, unknown>;
  const video = pick(j, 'video', 'video');
  const outgoing = pick(j, 'outgoing', 'outgoing');
  const durationS = pick(j, 'duration_s', 'durationS');
  const reason = pick(j, 'reason', 'reason');
  const out: ViewCall = {
    video: video === undefined || video === null ? false : Boolean(video),
    outgoing: outgoing === undefined || outgoing === null ? false : Boolean(outgoing),
    durationS: durationS === undefined || durationS === null ? 0 : Number(durationS),
    reason: reason === undefined || reason === null ? '' : String(reason),
  };
  return out;
}

export function viewCallToJson(m: ViewCall): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(!m.video)) j.video = m.video;
  if (!(!m.outgoing)) j.outgoing = m.outgoing;
  if (!(m.durationS === 0)) j.duration_s = m.durationS;
  if (!(m.reason === '')) j.reason = m.reason;
  return j;
}

export interface ViewCloudInvite {
  title: string;
  owner: string;
  role: string;
}

export function viewCloudInviteFromJson(v: unknown): ViewCloudInvite {
  const j = (v ?? {}) as Record<string, unknown>;
  const title = pick(j, 'title', 'title');
  const owner = pick(j, 'owner', 'owner');
  const role = pick(j, 'role', 'role');
  const out: ViewCloudInvite = {
    title: title === undefined || title === null ? '' : String(title),
    owner: owner === undefined || owner === null ? '' : String(owner),
    role: role === undefined || role === null ? '' : String(role),
  };
  return out;
}

export function viewCloudInviteToJson(m: ViewCloudInvite): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.title === '')) j.title = m.title;
  if (!(m.owner === '')) j.owner = m.owner;
  if (!(m.role === '')) j.role = m.role;
  return j;
}

export interface ViewContact {
  user: string;
  firstName: string;
  lastName: string;
}

export function viewContactFromJson(v: unknown): ViewContact {
  const j = (v ?? {}) as Record<string, unknown>;
  const user = pick(j, 'user', 'user');
  const firstName = pick(j, 'first_name', 'firstName');
  const lastName = pick(j, 'last_name', 'lastName');
  const out: ViewContact = {
    user: user === undefined || user === null ? '' : String(user),
    firstName: firstName === undefined || firstName === null ? '' : String(firstName),
    lastName: lastName === undefined || lastName === null ? '' : String(lastName),
  };
  return out;
}

export function viewContactToJson(m: ViewContact): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.user === '')) j.user = m.user;
  if (!(m.firstName === '')) j.first_name = m.firstName;
  if (!(m.lastName === '')) j.last_name = m.lastName;
  return j;
}

export interface ViewEntity {
  type: string;
  offset: number;
  length: number;
  url: string;
  user: string;
  language: string;
  customEmojiId: string;
}

export function viewEntityFromJson(v: unknown): ViewEntity {
  const j = (v ?? {}) as Record<string, unknown>;
  const type = pick(j, 'type', 'type');
  const offset = pick(j, 'offset', 'offset');
  const length = pick(j, 'length', 'length');
  const url = pick(j, 'url', 'url');
  const user = pick(j, 'user', 'user');
  const language = pick(j, 'language', 'language');
  const customEmojiId = pick(j, 'custom_emoji_id', 'customEmojiId');
  const out: ViewEntity = {
    type: type === undefined || type === null ? '' : String(type),
    offset: offset === undefined || offset === null ? 0 : Number(offset),
    length: length === undefined || length === null ? 0 : Number(length),
    url: url === undefined || url === null ? '' : String(url),
    user: user === undefined || user === null ? '' : String(user),
    language: language === undefined || language === null ? '' : String(language),
    customEmojiId: customEmojiId === undefined || customEmojiId === null ? '' : String(customEmojiId),
  };
  return out;
}

export function viewEntityToJson(m: ViewEntity): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.type === '')) j.type = m.type;
  if (!(m.offset === 0)) j.offset = m.offset;
  if (!(m.length === 0)) j.length = m.length;
  if (!(m.url === '')) j.url = m.url;
  if (!(m.user === '')) j.user = m.user;
  if (!(m.language === '')) j.language = m.language;
  if (!(m.customEmojiId === '')) j.custom_emoji_id = m.customEmojiId;
  return j;
}

export interface ViewGroupRequest {
  group?: Ref;
}

export function viewGroupRequestFromJson(v: unknown): ViewGroupRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const group = pick(j, 'group', 'group');
  const out: ViewGroupRequest = {
    group: group === undefined || group === null ? undefined : refFromJson(group),
  };
  return out;
}

export function viewGroupRequestToJson(m: ViewGroupRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.group === undefined)) j.group = refToJson(m.group!);
  return j;
}

export interface ViewLocation {
  lat: number;
  lon: number;
  title: string;
}

export function viewLocationFromJson(v: unknown): ViewLocation {
  const j = (v ?? {}) as Record<string, unknown>;
  const lat = pick(j, 'lat', 'lat');
  const lon = pick(j, 'lon', 'lon');
  const title = pick(j, 'title', 'title');
  const out: ViewLocation = {
    lat: lat === undefined || lat === null ? 0 : Number(lat),
    lon: lon === undefined || lon === null ? 0 : Number(lon),
    title: title === undefined || title === null ? '' : String(title),
  };
  return out;
}

export function viewLocationToJson(m: ViewLocation): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.lat === 0)) j.lat = m.lat;
  if (!(m.lon === 0)) j.lon = m.lon;
  if (!(m.title === '')) j.title = m.title;
  return j;
}

export interface ViewMedia {
  kind: string;
  fileId: string;
  blobDomain: string;
  key: Uint8Array;
  nonce: Uint8Array;
  capability: Uint8Array;
  mime: string;
  name: string;
  size: string;
  width: number;
  height: number;
  durationS: number;
  thumb: Uint8Array;
  caption?: ViewText;
  spoiler: boolean;
  captionAbove: boolean;
  waveform: Uint8Array;
  albumId: Uint8Array;
  title: string;
  performer: string;
}

export function viewMediaFromJson(v: unknown): ViewMedia {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const fileId = pick(j, 'file_id', 'fileId');
  const blobDomain = pick(j, 'blob_domain', 'blobDomain');
  const key = pick(j, 'key', 'key');
  const nonce = pick(j, 'nonce', 'nonce');
  const capability = pick(j, 'capability', 'capability');
  const mime = pick(j, 'mime', 'mime');
  const name = pick(j, 'name', 'name');
  const size = pick(j, 'size', 'size');
  const width = pick(j, 'width', 'width');
  const height = pick(j, 'height', 'height');
  const durationS = pick(j, 'duration_s', 'durationS');
  const thumb = pick(j, 'thumb', 'thumb');
  const caption = pick(j, 'caption', 'caption');
  const spoiler = pick(j, 'spoiler', 'spoiler');
  const captionAbove = pick(j, 'caption_above', 'captionAbove');
  const waveform = pick(j, 'waveform', 'waveform');
  const albumId = pick(j, 'album_id', 'albumId');
  const title = pick(j, 'title', 'title');
  const performer = pick(j, 'performer', 'performer');
  const out: ViewMedia = {
    kind: kind === undefined || kind === null ? '' : String(kind),
    fileId: fileId === undefined || fileId === null ? '' : String(fileId),
    blobDomain: blobDomain === undefined || blobDomain === null ? '' : String(blobDomain),
    key: key === undefined || key === null ? new Uint8Array(0) : fromBase64(String(key)),
    nonce: nonce === undefined || nonce === null ? new Uint8Array(0) : fromBase64(String(nonce)),
    capability: capability === undefined || capability === null ? new Uint8Array(0) : fromBase64(String(capability)),
    mime: mime === undefined || mime === null ? '' : String(mime),
    name: name === undefined || name === null ? '' : String(name),
    size: size === undefined || size === null ? '' : String(size),
    width: width === undefined || width === null ? 0 : Number(width),
    height: height === undefined || height === null ? 0 : Number(height),
    durationS: durationS === undefined || durationS === null ? 0 : Number(durationS),
    thumb: thumb === undefined || thumb === null ? new Uint8Array(0) : fromBase64(String(thumb)),
    caption: caption === undefined || caption === null ? undefined : viewTextFromJson(caption),
    spoiler: spoiler === undefined || spoiler === null ? false : Boolean(spoiler),
    captionAbove: captionAbove === undefined || captionAbove === null ? false : Boolean(captionAbove),
    waveform: waveform === undefined || waveform === null ? new Uint8Array(0) : fromBase64(String(waveform)),
    albumId: albumId === undefined || albumId === null ? new Uint8Array(0) : fromBase64(String(albumId)),
    title: title === undefined || title === null ? '' : String(title),
    performer: performer === undefined || performer === null ? '' : String(performer),
  };
  return out;
}

export function viewMediaToJson(m: ViewMedia): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.fileId === '')) j.file_id = m.fileId;
  if (!(m.blobDomain === '')) j.blob_domain = m.blobDomain;
  if (!(m.key.length === 0)) j.key = toBase64(m.key);
  if (!(m.nonce.length === 0)) j.nonce = toBase64(m.nonce);
  if (!(m.capability.length === 0)) j.capability = toBase64(m.capability);
  if (!(m.mime === '')) j.mime = m.mime;
  if (!(m.name === '')) j.name = m.name;
  if (!((m.size === '' || m.size === '0'))) j.size = m.size;
  if (!(m.width === 0)) j.width = m.width;
  if (!(m.height === 0)) j.height = m.height;
  if (!(m.durationS === 0)) j.duration_s = m.durationS;
  if (!(m.thumb.length === 0)) j.thumb = toBase64(m.thumb);
  if (!(m.caption === undefined)) j.caption = viewTextToJson(m.caption!);
  if (!(!m.spoiler)) j.spoiler = m.spoiler;
  if (!(!m.captionAbove)) j.caption_above = m.captionAbove;
  if (!(m.waveform.length === 0)) j.waveform = toBase64(m.waveform);
  if (!(m.albumId.length === 0)) j.album_id = toBase64(m.albumId);
  if (!(m.title === '')) j.title = m.title;
  if (!(m.performer === '')) j.performer = m.performer;
  return j;
}

export interface ViewPoll {
  question: string;
  options: string[];
  multiple: boolean;
  quiz: boolean;
  myVotes: number[];
  votes: number[];
}

export function viewPollFromJson(v: unknown): ViewPoll {
  const j = (v ?? {}) as Record<string, unknown>;
  const question = pick(j, 'question', 'question');
  const options = pick(j, 'options', 'options');
  const multiple = pick(j, 'multiple', 'multiple');
  const quiz = pick(j, 'quiz', 'quiz');
  const myVotes = pick(j, 'my_votes', 'myVotes');
  const votes = pick(j, 'votes', 'votes');
  const out: ViewPoll = {
    question: question === undefined || question === null ? '' : String(question),
    options: Array.isArray(options) ? options.map((x) => String(x)) : [],
    multiple: multiple === undefined || multiple === null ? false : Boolean(multiple),
    quiz: quiz === undefined || quiz === null ? false : Boolean(quiz),
    myVotes: Array.isArray(myVotes) ? myVotes.map((x) => Number(x)) : [],
    votes: Array.isArray(votes) ? votes.map((x) => Number(x)) : [],
  };
  return out;
}

export function viewPollToJson(m: ViewPoll): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.question === '')) j.question = m.question;
  if (m.options.length) j.options = m.options.map((x) => x);
  if (!(!m.multiple)) j.multiple = m.multiple;
  if (!(!m.quiz)) j.quiz = m.quiz;
  if (m.myVotes.length) j.my_votes = m.myVotes.map((x) => x);
  if (m.votes.length) j.votes = m.votes.map((x) => x);
  return j;
}

export interface ViewReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export function viewReactionFromJson(v: unknown): ViewReaction {
  const j = (v ?? {}) as Record<string, unknown>;
  const emoji = pick(j, 'emoji', 'emoji');
  const count = pick(j, 'count', 'count');
  const mine = pick(j, 'mine', 'mine');
  const out: ViewReaction = {
    emoji: emoji === undefined || emoji === null ? '' : String(emoji),
    count: count === undefined || count === null ? 0 : Number(count),
    mine: mine === undefined || mine === null ? false : Boolean(mine),
  };
  return out;
}

export function viewReactionToJson(m: ViewReaction): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.emoji === '')) j.emoji = m.emoji;
  if (!(m.count === 0)) j.count = m.count;
  if (!(!m.mine)) j.mine = m.mine;
  return j;
}

export interface ViewService {
  kind: string;
  actor: string;
  targets: string[];
  text: string;
}

export function viewServiceFromJson(v: unknown): ViewService {
  const j = (v ?? {}) as Record<string, unknown>;
  const kind = pick(j, 'kind', 'kind');
  const actor = pick(j, 'actor', 'actor');
  const targets = pick(j, 'targets', 'targets');
  const text = pick(j, 'text', 'text');
  const out: ViewService = {
    kind: kind === undefined || kind === null ? '' : String(kind),
    actor: actor === undefined || actor === null ? '' : String(actor),
    targets: Array.isArray(targets) ? targets.map((x) => String(x)) : [],
    text: text === undefined || text === null ? '' : String(text),
  };
  return out;
}

export function viewServiceToJson(m: ViewService): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.kind === '')) j.kind = m.kind;
  if (!(m.actor === '')) j.actor = m.actor;
  if (m.targets.length) j.targets = m.targets.map((x) => x);
  if (!(m.text === '')) j.text = m.text;
  return j;
}

export interface ViewStateRequest {
  kinds: string[];
}

export function viewStateRequestFromJson(v: unknown): ViewStateRequest {
  const j = (v ?? {}) as Record<string, unknown>;
  const kinds = pick(j, 'kinds', 'kinds');
  const out: ViewStateRequest = {
    kinds: Array.isArray(kinds) ? kinds.map((x) => String(x)) : [],
  };
  return out;
}

export function viewStateRequestToJson(m: ViewStateRequest): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (m.kinds.length) j.kinds = m.kinds.map((x) => x);
  return j;
}

export interface ViewSticker {
  pack: string;
  stickerId: string;
  emoji: string;
  media?: ViewMedia;
}

export function viewStickerFromJson(v: unknown): ViewSticker {
  const j = (v ?? {}) as Record<string, unknown>;
  const pack = pick(j, 'pack', 'pack');
  const stickerId = pick(j, 'sticker_id', 'stickerId');
  const emoji = pick(j, 'emoji', 'emoji');
  const media = pick(j, 'media', 'media');
  const out: ViewSticker = {
    pack: pack === undefined || pack === null ? '' : String(pack),
    stickerId: stickerId === undefined || stickerId === null ? '' : String(stickerId),
    emoji: emoji === undefined || emoji === null ? '' : String(emoji),
    media: media === undefined || media === null ? undefined : viewMediaFromJson(media),
  };
  return out;
}

export function viewStickerToJson(m: ViewSticker): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.pack === '')) j.pack = m.pack;
  if (!(m.stickerId === '')) j.sticker_id = m.stickerId;
  if (!(m.emoji === '')) j.emoji = m.emoji;
  if (!(m.media === undefined)) j.media = viewMediaToJson(m.media!);
  return j;
}

export interface ViewTaskOffer {
  title: string;
  text: string;
  taskId: Uint8Array;
}

export function viewTaskOfferFromJson(v: unknown): ViewTaskOffer {
  const j = (v ?? {}) as Record<string, unknown>;
  const title = pick(j, 'title', 'title');
  const text = pick(j, 'text', 'text');
  const taskId = pick(j, 'task_id', 'taskId');
  const out: ViewTaskOffer = {
    title: title === undefined || title === null ? '' : String(title),
    text: text === undefined || text === null ? '' : String(text),
    taskId: taskId === undefined || taskId === null ? new Uint8Array(0) : fromBase64(String(taskId)),
  };
  return out;
}

export function viewTaskOfferToJson(m: ViewTaskOffer): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.title === '')) j.title = m.title;
  if (!(m.text === '')) j.text = m.text;
  if (!(m.taskId.length === 0)) j.task_id = toBase64(m.taskId);
  return j;
}

export interface ViewText {
  text: string;
  entities: ViewEntity[];
}

export function viewTextFromJson(v: unknown): ViewText {
  const j = (v ?? {}) as Record<string, unknown>;
  const text = pick(j, 'text', 'text');
  const entities = pick(j, 'entities', 'entities');
  const out: ViewText = {
    text: text === undefined || text === null ? '' : String(text),
    entities: Array.isArray(entities) ? entities.map((x) => viewEntityFromJson(x)) : [],
  };
  return out;
}

export function viewTextToJson(m: ViewText): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.text === '')) j.text = m.text;
  if (m.entities.length) j.entities = m.entities.map((x) => viewEntityToJson(x));
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

export interface WriteBlocked {
  journal: string;
  reason: JournalWrite;
}

export function writeBlockedFromJson(v: unknown): WriteBlocked {
  const j = (v ?? {}) as Record<string, unknown>;
  const journal = pick(j, 'journal', 'journal');
  const reason = pick(j, 'reason', 'reason');
  const out: WriteBlocked = {
    journal: journal === undefined || journal === null ? '' : String(journal),
    reason: reason === undefined || reason === null ? JournalWriteValues[0] : journalWriteFromJson(reason),
  };
  return out;
}

export function writeBlockedToJson(m: WriteBlocked): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (!(m.journal === '')) j.journal = m.journal;
  if (!(m.reason === JournalWriteValues[0])) j.reason = m.reason;
  return j;
}

