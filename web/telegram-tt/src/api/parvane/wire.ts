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
  width?: number;
  height?: number;
  caption?: string;
  ciphertext?: string;
  ctype?: number;
  sender_identity?: string;
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
export const TOPIC_IDENTITY_RESOLVE = 'identity.user.resolve';
export const TOPIC_IDENTITY_SEARCH = 'identity.user.search';
export const TOPIC_IDENTITY_SETNAME = 'identity.user.setname';
export const TOPIC_IDENTITY_SETAVATAR = 'identity.user.setavatar';
export const TOPIC_IDENTITY_SETKEY = 'identity.user.setkey';
export const TOPIC_PREKEYS_PUBLISH = 'identity.prekeys.publish';
export const TOPIC_PREKEYS_FETCH = 'identity.prekeys.fetch';
export const TOPIC_MSG_SEND = 'msg.chat.send';
export const TOPIC_MSG_ACK = 'msg.chat.ack';
export const TOPIC_MSG_READ = 'msg.chat.read';
export const TOPIC_MSG_EDIT = 'msg.chat.edit';
export const TOPIC_MSG_DELETE = 'msg.chat.delete';
export const TOPIC_MSG_REACT = 'msg.chat.react';
export const TOPIC_MSG_PIN = 'msg.chat.pin';
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
export const TOPIC_CALL_SIGNAL = 'call.signal';

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
