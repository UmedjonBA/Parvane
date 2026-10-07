// Wire-типы содержимого Parvane (JSON внутри E2E-содержимого и запросов моста
// v2). Поля — snake_case, как в `backend/shared/parvane-types`. Subject'ы
// `TOPIC_*` — имена запросов прежней формы, которые мост `v2/bridge.ts`
// переводит в методы v2.

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
  // Секрет скачивания блоба (v2, D-08): только в E2E-содержимом v2-чата
  capability?: string;
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
  file_key?: string;
  // Секрет скачивания блоба вложения (v2, FR-062/D-08): сервер хранит только
  // SHA-256, получатель качает блоб анонимным каналом без гранта на себя
  capability?: string;
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
  // kind=chat_mode (протокол v2, FR-036): участник включил/выключил режим
  // «усиленная приватность» (L2) — служебное сообщение чата
  l2?: boolean;
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
  // Строка собрана из события движка v2 (spec 007) или своей отправки — её id
  // выбирает отправитель; строки кэша без пометки — история прежних сборок
  origin?: 'v2';
};

// Права участников по умолчанию (spec 003): позитивные флаги «разрешено».
// Отсутствующее поле = значение по умолчанию (как в Telegram).
export type WireDefaultPermissions = {
  send_messages?: boolean;
  send_media?: boolean;
  send_stickers_gifs?: boolean;
  send_polls?: boolean;
  embed_links?: boolean;
  invite_users?: boolean;
  pin_messages?: boolean;
  change_info?: boolean;
};

// Гранулярные права админа (spec 003). У legacy-админа сервер отдаёт полный набор.
export type WireAdminRights = {
  change_info?: boolean;
  delete_messages?: boolean;
  ban_users?: boolean;
  invite_users?: boolean;
  pin_messages?: boolean;
  add_admins?: boolean;
};

export type WireGroupMember = {
  address: string;
  role: string;
  admin_rights?: WireAdminRights;
  promoted_by?: string;
};

export type WireGroupInfo = {
  group_id: string;
  name: string;
  kind: 'group' | 'channel';
  created_by: string;
  members: WireGroupMember[];
  // file_id фото группы в cloud (открытый объект, как аватар пользователя)
  avatar?: string;
  about?: string;
  default_permissions?: WireDefaultPermissions;
  // Ревизия сведений: применять только при version >= локальной (GROUP-1)
  version?: number;
  // Только владельцу и админам с invite_users
  pending_requests?: number;
  // Группа v2, переведённая из v1 (T180): прежний `group_id` — тот же чат в UI
  migrated_from?: string;
};

// Инвайт-ссылка группы (group.invite.list / group.invite.create)

// Превью ссылки до вступления (group.invite.check)

// Уведомление об изменении группы в кадре инбокса: поле `group` вместо
// `message` (как `notify`/`read`/`cleared`); старые клиенты кадр игнорируют

export type WireUserInfo = {
  username: string;
  display_name: string;
  avatar?: string;
  pubkey?: string;
  bio?: string;
  birthday?: string;
  name_color?: number;
  personal_channel?: string;
  phone?: string;
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
export const TOPIC_IDENTITY_REGISTER_STATUS = 'identity.register.status';
export const TOPIC_IDENTITY_TWOFA = 'identity.user.twofa';
export const TOPIC_IDENTITY_PASSWORD_CHANGE = 'identity.password.change';
export const TOPIC_IDENTITY_RESOLVE = 'identity.user.resolve';
export const TOPIC_IDENTITY_SEARCH = 'identity.user.search';
export const TOPIC_IDENTITY_SETNAME = 'identity.user.setname';
export const TOPIC_IDENTITY_SETAVATAR = 'identity.user.setavatar';
export const TOPIC_DEVICE_LIST = 'identity.device.list';
export const TOPIC_DEVICE_REVOKE = 'identity.device.revoke';
export const TOPIC_LINK_OFFER = 'identity.link.offer';
export const TOPIC_LINK_POLL = 'identity.link.poll';
export const TOPIC_LINK_GRANT = 'identity.link.grant';
export const TOPIC_LINK_CHALLENGE = 'identity.link.challenge';
// Очистка истории «для меня»: пачка id скрывается из sync только для нас
// Максимум id в одном msg.chat.clear (как CLEAR_MAX_IDS на сервере)
export const TOPIC_PREVIEW_FETCH = 'preview.link.fetch';
export const TOPIC_PREVIEW_MAP_TILE = 'preview.map.tile';
export const TOPIC_PUSH_VAPID_GET = 'push.vapid.get';
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

export const TOPIC_FILE_DELETE = 'file.delete';

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
