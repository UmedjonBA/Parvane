// Wire-типы протокола Parvane (NATS/JSON через gateway). Поля — snake_case,
// как в `shared/parvane-types`. Контракт бэкенда стабилен, клиент подстраивается.

export type WireTextEntity = {
  type: string;
  offset: number;
  length: number;
  data?: string;
};

export type WireWebPage = {
  url: string;
  site_name?: string;
  title?: string;
  description?: string;
};

// Ссылка на стикер-пак при отправке стикера из кастомного набора: архив PVPK1
// грузится в cloud шифртекстом (blobcrypt), key+nonce едут в E2E-контенте.
// Формат идентичен desktop-форку
export type WirePackRef = {
  file_id: string;
  name: string;
  count: number;
  key?: string;
  nonce?: string;
};

export type WireMessageContent = {
  kind: string;
  text?: string;
  entities?: WireTextEntity[];
  webpage?: WireWebPage;
  file_id?: string;
  filename?: string;
  mime?: string;
  size_bytes?: number;
  duration_secs?: number;
  // Упакованные 5-битные сэмплы волны (63 байта); поле только Web↔Web —
  // desktop его игнорирует и пересчитывает волну из файла
  waveform?: number[];
  // Метаданные аудиофайла (kind=file с mime audio/*); только Web↔Web,
  // desktop игнорирует
  audio_title?: string;
  audio_performer?: string;
  width?: number;
  height?: number;
  caption?: string;
  ciphertext?: string;
  ctype?: number;
  sender_identity?: string;
  sender_signing_key?: string;
  file_key?: string;
  file_nonce?: string;
  group?: string;
  session_key?: string;
  epoch?: number;
  ttl_secs?: number;
  forwarded_from?: string;
  forwarded_name?: string;
  lat?: number;
  long?: number;
  // Live-локация: период трансляции (сек от ts сообщения), курс, точность (м).
  // Обновления позиции едут штатной правкой (msg.chat.edit) с тем же kind
  live_period?: number;
  heading?: number;
  accuracy?: number;
  pack_ref?: WirePackRef;
  // Кастом-эмодзи в тексте: паки, на которые ссылаются entity custom_emoji
  // (data = docId, детерминированный от имени пака и файла — как в desktop)
  emoji_packs?: WirePackRef[];
  // Опросы: агрегируются клиентами внутри E2E; correct/solution — quiz-режим.
  // options: string[] в kind=poll (варианты), number[] в kind=poll_vote (индексы)
  question?: string;
  options?: string[] | number[];
  is_public?: boolean;
  is_multiple?: boolean;
  is_quiz?: boolean;
  correct?: number[];
  solution?: string;
  poll?: string;
};

// Per-device sealed-копия (мультидевайс): recipient пуст у self-копий
// отправителя — владельца тогда определяет signing_key (как в sync)
export type WireDeviceCopy = {
  recipient?: string;
  signing_key?: string;
  device_id: string;
  ciphertext: string;
  ctype?: number;
};

export type WireStoredMessage = {
  id: string;
  from: string;
  to: string;
  content: WireMessageContent;
  ts: number;
  reply_to?: string;
  edited?: boolean;
  deleted?: boolean;
  read?: boolean;
  updated_at?: number;
  reactions?: { emoji: string; count: number; mine?: boolean }[];
  pinned?: boolean;
  // Заполнено только в live-пуше инбокса: копии адресата, устройство выбирает
  // свою по device_id (в sync-ответах сервер уже подменил ciphertext)
  copies?: WireDeviceCopy[];
};

export type WireGroupMember = {
  address: string;
  role: string;
};

export type WireGroupInfo = {
  group_id: string;
  name: string;
  kind: 'group' | 'channel';
  created_by: string;
  members: WireGroupMember[];
};

export type WireUserInfo = {
  username: string;
  display_name: string;
  avatar?: string;
  pubkey?: string;
};

export type WireEvent<T> = {
  id: string;
  from: string;
  ts: number;
  token: string;
  payload: T;
};

export const TOPIC_IDENTITY_ISSUE = 'identity.token.issue';
export const TOPIC_IDENTITY_REGISTER = 'identity.user.register';
export const TOPIC_IDENTITY_EMAIL_CONFIRM = 'identity.email.confirm';
export const TOPIC_IDENTITY_SERVER_INFO = 'identity.server.info';
export const TOPIC_IDENTITY_RESOLVE = 'identity.user.resolve';
export const TOPIC_IDENTITY_SEARCH = 'identity.user.search';
export const TOPIC_IDENTITY_SETNAME = 'identity.user.setname';
export const TOPIC_IDENTITY_SETAVATAR = 'identity.user.setavatar';
export const TOPIC_IDENTITY_SETKEY = 'identity.user.setkey';
export const TOPIC_PREKEYS_PUBLISH = 'identity.prekeys.publish';
export const TOPIC_PREKEYS_FETCH = 'identity.prekeys.fetch';
export const TOPIC_DEVICE_LIST = 'identity.device.list';
export const TOPIC_DEVICE_REVOKE = 'identity.device.revoke';
export const TOPIC_LINK_OFFER = 'identity.link.offer';
export const TOPIC_LINK_POLL = 'identity.link.poll';
export const TOPIC_LINK_GRANT = 'identity.link.grant';
export const TOPIC_MSG_SEND = 'msg.chat.send';
export const TOPIC_MSG_ACK = 'msg.chat.ack';
export const TOPIC_MSG_READ = 'msg.chat.read';
export const TOPIC_MSG_READERS = 'msg.chat.readers';
export const TOPIC_MSG_EDIT = 'msg.chat.edit';
export const TOPIC_MSG_DELETE = 'msg.chat.delete';
export const TOPIC_MSG_REACT = 'msg.chat.react';
export const TOPIC_MSG_PIN = 'msg.chat.pin';
// Очистка истории «для меня»: пачка id скрывается из sync только для нас
export const TOPIC_MSG_CLEAR = 'msg.chat.clear';
// Максимум id в одном msg.chat.clear (как CLEAR_MAX_IDS на сервере)
export const CLEAR_MAX_IDS = 500;
export const TOPIC_MSG_SYNC_REQUEST = 'msg.sync.request';
export const TOPIC_GROUP_LIST = 'group.list';
export const TOPIC_GROUP_CREATE = 'group.create';
export const TOPIC_GROUP_INFO = 'group.info';
export const TOPIC_GROUP_ADD_MEMBER = 'group.addmember';
export const TOPIC_GROUP_REMOVE_MEMBER = 'group.removemember';
export const TOPIC_GROUP_BAN = 'group.ban';
export const TOPIC_GROUP_UNBAN = 'group.unban';
export const TOPIC_GROUP_MUTE = 'group.mute';
export const TOPIC_GROUP_INVITE_CREATE = 'group.invite.create';
export const TOPIC_GROUP_JOIN = 'group.join';
export const TOPIC_GROUP_SET_ROLE = 'group.setrole';
export const TOPIC_GROUP_RENAME = 'group.rename';
export const TOPIC_GROUP_DELETE = 'group.delete';
export const TOPIC_PREVIEW_FETCH = 'preview.link.fetch';
export const TOPIC_PREVIEW_MAP_TILE = 'preview.map.tile';
export const TOPIC_PUSH_VAPID_GET = 'push.vapid.get';
export const TOPIC_PUSH_REGISTER = 'push.device.register';
export const TOPIC_PUSH_UNREGISTER = 'push.device.unregister';
export const TOPIC_CALL_SIGNAL = 'call.signal';
export const TOPIC_CALL_HISTORY_REQUEST = 'call.history.request';
export const TOPIC_CALL_ICE_REQUEST = 'call.ice.request';

export type WireIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type WireCallRecord = {
  call_id: string;
  caller: string;
  callee: string;
  media: string;
  status: 'ringing' | 'answered' | 'ended' | 'missed' | 'rejected';
  started_at: number;
  ended_at?: number;
  // Pairwise-запись группового mesh-звонка — в личной истории не показывается
  is_group?: boolean;
};

export function buildCallInboxTopic(user: string) {
  return `call.user.${user}`;
}
export const TOPIC_FILE_UPLOAD_CHUNK = 'file.upload.chunk';
export const TOPIC_FILE_UPLOAD_COMPLETE = 'file.upload.complete';
export const TOPIC_FILE_DOWNLOAD_REQUEST = 'file.download.request';

export function buildMsgInboxTopic(user: string) {
  return `msg.user.${user}`;
}

export function buildWireEvent<T>(from: string, token: string, payload: T): WireEvent<T> {
  return {
    id: crypto.randomUUID(),
    from,
    ts: Math.floor(Date.now() / 1000),
    token,
    payload,
  };
}

// UUID v7 (48-битный unix-ms timestamp + рандом) — ВРЕМЕННО-УПОРЯДОЧЕННЫЙ id.
// Критично для id СООБЩЕНИЙ: messenger ведёт sync-курсор `last_seen_id` строковым
// сравнением `m.id > ?`, поэтому случайный v4 позволял курсору «перепрыгнуть»
// сообщение с лексикографически меньшим id и больше его не отдавать. v7
// монотонен по времени → строковый порядок совпадает с временным.
export function newMessageId(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // версия 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
