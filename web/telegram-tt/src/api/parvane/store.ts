// Локальный реестр Parvane: адреса ↔ телеграм-подобные id, история сообщений,
// нумерация msgId. Принцип как в десктоп-форке: синтезируем объекты `Api*`
// из наших NATS-событий и кормим ими нативный UI.

import type {
  ApiChat, ApiMessage, ApiUser,
} from '../types';
import type { WireGroupInfo, WireStoredMessage } from './wire';
import { wireEntitiesToApi } from './entities';

type PeerKind = 'user' | 'group' | 'channel';

// FNV-1a 32-бит от адреса → положительный числовой id (стабильный между сессиями)
function buildHashedId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash >>> 1);
}

export class ParvaneStore {
  self = '';

  private addressById = new Map<string, string>();

  private kindByAddress = new Map<string, PeerKind>();

  private displayNameByAddress = new Map<string, string>();

  private avatarByAddress = new Map<string, string>();

  private groupInfoByAddress = new Map<string, WireGroupInfo>();

  private messagesByChatId = new Map<string, ApiMessage[]>();

  private msgKeyByUuid = new Map<string, { chatId: string; id: number }>();

  private uuidByMsgKey = new Map<string, string>();

  private nextMsgIdByChatId = new Map<string, number>();

  getIdForAddress(address: string, kind: PeerKind = 'user'): string {
    const existingKind = this.kindByAddress.get(address);
    const actualKind = existingKind || kind;
    if (!existingKind) this.kindByAddress.set(address, actualKind);

    const raw = buildHashedId(actualKind === 'user' ? address : `group:${address}`);
    const id = actualKind === 'user' ? raw : `-${raw}`;
    this.addressById.set(id, address);
    return id;
  }

  getAddressForId(id: string) {
    return this.addressById.get(id);
  }

  registerGroup(info: WireGroupInfo) {
    this.kindByAddress.set(info.group_id, info.kind === 'channel' ? 'channel' : 'group');
    this.groupInfoByAddress.set(info.group_id, info);
    this.displayNameByAddress.set(info.group_id, info.name);
  }

  isGroupAddress(address: string) {
    return this.groupInfoByAddress.has(address);
  }

  getGroupInfo(address: string) {
    return this.groupInfoByAddress.get(address);
  }

  getGroupAddresses() {
    return Array.from(this.groupInfoByAddress.keys());
  }

  setDisplayName(address: string, name: string) {
    this.displayNameByAddress.set(address, name);
  }

  getDisplayName(address: string) {
    return this.displayNameByAddress.get(address) || address.split('@')[0];
  }

  setAvatar(address: string, fileId: string | undefined) {
    if (fileId) this.avatarByAddress.set(address, fileId);
    else this.avatarByAddress.delete(address);
  }

  getAvatar(address: string) {
    return this.avatarByAddress.get(address);
  }

  // Куда (в какой чат) кладётся сообщение с точки зрения этого клиента
  resolveChatAddress(message: WireStoredMessage): string {
    if (this.isGroupAddress(message.to)) return message.to;
    if (message.from && message.from !== this.self) return message.from;
    return message.to;
  }

  hasMessage(uuid: string) {
    return this.msgKeyByUuid.has(uuid);
  }

  getUuidForMessage(chatId: string, id: number) {
    return this.uuidByMsgKey.get(`${chatId}:${id}`);
  }

  allocateMessageId(chatId: string, uuid: string): number {
    const known = this.msgKeyByUuid.get(uuid);
    if (known) return known.id;
    const id = this.nextMsgIdByChatId.get(chatId) || 1;
    this.nextMsgIdByChatId.set(chatId, id + 1);
    this.msgKeyByUuid.set(uuid, { chatId, id });
    this.uuidByMsgKey.set(`${chatId}:${id}`, uuid);
    return id;
  }

  putMessage(message: ApiMessage) {
    const list = this.messagesByChatId.get(message.chatId) || [];
    const index = list.findIndex((m) => m.id === message.id);
    if (index >= 0) {
      list[index] = message;
    } else {
      list.push(message);
      list.sort((a, b) => a.id - b.id);
    }
    this.messagesByChatId.set(message.chatId, list);
  }

  getMessages(chatId: string): ApiMessage[] {
    return this.messagesByChatId.get(chatId) || [];
  }

  removeMessage(chatId: string, id: number) {
    const list = this.messagesByChatId.get(chatId);
    if (list) this.messagesByChatId.set(chatId, list.filter((m) => m.id !== id));
  }

  getChatIds() {
    return Array.from(this.messagesByChatId.keys());
  }

  getKnownUserAddresses() {
    return Array.from(this.kindByAddress.entries())
      .filter(([, kind]) => kind === 'user')
      .map(([address]) => address);
  }

  buildApiUser(address: string): ApiUser {
    const isSelf = address === this.self;
    const id = this.getIdForAddress(address);
    return {
      id,
      isMin: false,
      isSelf: isSelf ? true : undefined,
      isContact: isSelf ? undefined : true,
      type: 'userTypeRegular',
      firstName: this.getDisplayName(address),
      phoneNumber: '',
      color: { type: 'regular', color: Number(id) % 7 },
      avatarPhotoId: this.avatarByAddress.get(address),
    };
  }

  buildApiChatForUser(address: string): ApiChat {
    const id = this.getIdForAddress(address);
    return {
      id,
      type: 'chatTypePrivate',
      title: this.getDisplayName(address),
      isListed: true,
      color: { type: 'regular', color: Number(id) % 7 },
    };
  }

  buildApiChatForGroup(info: WireGroupInfo): ApiChat {
    const isChannel = info.kind === 'channel';
    return {
      id: this.getIdForAddress(info.group_id, isChannel ? 'channel' : 'group'),
      type: isChannel ? 'chatTypeChannel' : 'chatTypeBasicGroup',
      title: info.name,
      isListed: true,
      isCreator: info.created_by === this.self ? true : undefined,
      membersCount: info.members.length,
    };
  }

  buildApiMessage(stored: WireStoredMessage): ApiMessage {
    const chatAddress = this.resolveChatAddress(stored);
    const chatKind = this.kindByAddress.get(chatAddress) || 'user';
    const chatId = this.getIdForAddress(chatAddress, chatKind);
    const id = this.allocateMessageId(chatId, stored.id);
    const isOutgoing = stored.from === this.self;

    const replyKey = stored.reply_to ? this.msgKeyByUuid.get(stored.reply_to) : undefined;

    return {
      id,
      chatId,
      content: buildMessageContent(stored),
      date: stored.ts,
      isOutgoing,
      senderId: stored.from ? this.getIdForAddress(stored.from) : undefined,
      isEdited: stored.edited ? true : undefined,
      isPinned: stored.pinned ? true : undefined,
      replyInfo: replyKey && replyKey.chatId === chatId
        ? { type: 'message', replyToMsgId: replyKey.id }
        : undefined,
      reactions: buildReactions(stored),
    };
  }
}

// Полная карточка превью для newMessage.webPages (id связан с content.webPage)
export function buildWebPage(stored: WireStoredMessage) {
  const wp = stored.content.webpage;
  if (!wp) return undefined;
  let displayUrl = wp.url;
  try {
    displayUrl = new URL(wp.url).hostname;
  } catch {
    // оставляем как есть
  }
  return {
    mediaType: 'webpage' as const,
    webpageType: 'full' as const,
    id: `wp${stored.id}`,
    url: wp.url,
    hash: 0,
    displayUrl,
    siteName: wp.site_name,
    title: wp.title,
    description: wp.description,
  };
}

function buildReactions(stored: WireStoredMessage): ApiMessage['reactions'] {
  const list = stored.reactions;
  if (!list?.length) return undefined;
  return {
    results: list.map((r) => ({
      count: r.count,
      reaction: { type: 'emoji', emoticon: r.emoji },
      chosenOrder: r.mine ? 0 : undefined,
    })),
  };
}

function buildMessageContent(stored: WireStoredMessage): ApiMessage['content'] {
  const { content, deleted, ts } = stored;
  if (deleted) {
    return { text: { text: '🗑 Сообщение удалено' } };
  }
  const caption = content.caption ? { text: { text: content.caption } } : {};
  switch (content.kind) {
    case 'text':
      return {
        text: { text: content.text || '', entities: wireEntitiesToApi(content.entities) },
        webPage: content.webpage ? { id: `wp${stored.id}` } : undefined,
      };
    case 'photo':
      return {
        ...caption,
        photo: {
          mediaType: 'photo',
          id: content.file_id!,
          date: ts,
          sizes: [
            { type: 'x', width: content.width || 800, height: content.height || 600 },
            { type: 'y', width: content.width || 800, height: content.height || 600 },
          ],
        },
      };
    case 'file':
    case 'video':
    case 'voice':
    case 'video_note':
      // Видео/голос пока отдаются документом (progressive-стриминг — позже)
      return {
        ...caption,
        document: {
          mediaType: 'document',
          id: content.file_id!,
          fileName: content.filename
            || `${content.kind}-${(content.file_id || '').slice(0, 8)}${extForMime(content.mime)}`,
          size: content.size_bytes || 0,
          mimeType: content.mime || 'application/octet-stream',
          timestamp: ts,
        },
      };
    case 'encrypted':
    case 'group_encrypted':
      return { text: { text: '🔒 Зашифрованное сообщение (E2E в вебе ещё не поддержан)' } };
    default:
      return { text: { text: `📎 ${content.kind}: ${content.filename || content.file_id || ''}` } };
  }
}

function extForMime(mime?: string) {
  if (!mime) return '';
  const known: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
  };
  return known[mime] || '';
}
