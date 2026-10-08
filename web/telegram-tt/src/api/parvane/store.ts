// Локальный реестр Parvane: адреса ↔ телеграм-подобные id, история сообщений,
// нумерация msgId. Принцип как в десктоп-форке: синтезируем объекты `Api*`
// из наших NATS-событий и кормим ими нативный UI.

import type {
  ApiChat, ApiChatAdminRights, ApiChatBannedRights, ApiMessage, ApiUser,
} from '../types';
import type {
  WireAdminRights, WireDefaultPermissions, WireGroupInfo, WireStoredMessage,
} from './wire';

import { wireEntitiesToApi } from './entities';
import { registerReceivedEmojiPackRef, registerReceivedPackRef } from './stickerPacks';

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

// Ключи локализации служебного сообщения о режиме «усиленная приватность»
// (L2) и тексты на случай, когда языковой пакет ещё не загружен
const CHAT_MODE_KEYS = {
  own: { on: 'ParvaneL2EnabledYou', off: 'ParvaneL2DisabledYou' },
  peer: { on: 'ParvaneL2Enabled', off: 'ParvaneL2Disabled' },
} as const;

const CHAT_MODE_FALLBACK: Record<string, string> = {
  ParvaneL2EnabledYou: 'You enabled enhanced privacy',
  ParvaneL2DisabledYou: 'You disabled enhanced privacy',
  ParvaneL2Enabled: '{user} enabled enhanced privacy',
  ParvaneL2Disabled: '{user} disabled enhanced privacy',
};

export class ParvaneStore {
  self = '';

  private addressById = new Map<string, string>();

  // Группа v1, переведённая в v2 (T180): прежний `group_id` → адрес группы v2.
  // Чат в UI остаётся прежним (id считается от прежнего адреса), история v1 в нём
  private migratedTo = new Map<string, string>();

  private migratedFrom = new Map<string, string>();

  private kindByAddress = new Map<string, PeerKind>();

  private displayNameByAddress = new Map<string, string>();

  private avatarByAddress = new Map<string, string>();
  private profileByAddress = new Map<string, {
    bio?: string; birthday?: string; nameColor?: number;
    personalChannel?: string; phone?: string;
  }>();

  // Parvane: явно добавленные контакты (localStorage); плюс контактом считаем
  // каждого, с кем есть личная переписка. Раньше isContact стоял у всех
  // известных пользователей — в «Контакты» попадал весь каталог сервера
  private contactAddresses = new Set<string>();

  private groupInfoByAddress = new Map<string, WireGroupInfo>();

  // Ревизия сведений группы (GROUP-1): применять только не старее известной
  private groupVersionByAddress = new Map<string, number>();

  private messagesByChatId = new Map<string, ApiMessage[]>();

  // Индекс id → сообщение на чат: раньше putMessage искал перебором и
  // пересортировывал весь чат на каждое сообщение
  private messageByIdByChatId = new Map<string, Map<number, ApiMessage>>();

  private msgKeyByUuid = new Map<string, { chatId: string; id: number }>();

  private uuidByMsgKey = new Map<string, string>();

  private usedMsgIdsByChatId = new Map<string, Set<number>>();

  // uuid сообщений, реально положенных в стор (putMessage). Раньше hasMessage
  // отвечал по msgKeyByUuid, который заполняет allocateMessageId — и локальное
  // эхо с провалившейся отправкой считалось «известным»
  private storedUuids = new Set<string>();

  // P-18: первое появление адреса пользователя — повод подписаться на его
  // presence (вместо presence.* всех). Устанавливает провайдер
  onUserRegistered?: (peerId: string, address: string) => void;

  // Строка локализации для служебных сообщений чата. Устанавливает провайдер:
  // импорт lang-провайдера в этот слой тянет UI-модули
  getLangString?: (key: string) => string | undefined;

  // Адрес чата с учётом перевода группы из v1 в v2 (T180)
  canonicalAddress(address: string) {
    return this.migratedTo.get(address) ?? address;
  }

  isMigratedGroup(address: string) {
    return this.migratedTo.has(address);
  }

  getIdForAddress(rawAddress: string, kind: PeerKind = 'user'): string {
    const address = this.canonicalAddress(rawAddress);
    const existingKind = this.kindByAddress.get(address);
    const actualKind = existingKind || kind;
    if (!existingKind) this.kindByAddress.set(address, actualKind);

    const seed = this.migratedFrom.get(address) ?? address;
    const raw = buildHashedId(actualKind === 'user' ? seed : `group:${seed}`);
    const id = actualKind === 'user' ? raw : `-${raw}`;
    const isNew = !this.addressById.has(id);
    this.addressById.set(id, address);
    if (isNew && actualKind === 'user' && address !== this.self) this.onUserRegistered?.(id, address);
    return id;
  }

  getAddressForId(id: string) {
    return this.addressById.get(id);
  }

  // Сведения группы применяются по ревизии `version` (conformance GROUP-1):
  // нотис или список, догнавший более свежие сведения, не откатывает их.
  // Возвращает false, если пришедшая ревизия старее известной
  registerGroup(info: WireGroupInfo): boolean {
    // Сведения v1 о группе, уже переведённой в v2, не применяются: её ведёт журнал v2
    if (this.migratedTo.has(info.group_id)) return false;
    if (!shouldApplyGroupInfo(this.groupVersionByAddress.get(info.group_id), info.version)) {
      return false;
    }
    const kind = info.kind === 'channel' ? 'channel' : 'group';
    if (info.migrated_from && !this.migratedFrom.has(info.group_id)) {
      this.migratedTo.set(info.migrated_from, info.group_id);
      this.migratedFrom.set(info.group_id, info.migrated_from);
      this.groupInfoByAddress.delete(info.migrated_from);
      this.groupVersionByAddress.delete(info.migrated_from);
      this.kindByAddress.set(info.group_id, kind);
      // id чата теперь ведёт на адрес v2 (отправка, typing, сведения)
      this.getIdForAddress(info.group_id, kind);
    }
    this.kindByAddress.set(info.group_id, kind);
    this.groupInfoByAddress.set(info.group_id, info);
    this.groupVersionByAddress.set(info.group_id, info.version ?? 0);
    this.displayNameByAddress.set(info.group_id, info.name);
    return true;
  }

  getGroupVersion(address: string) {
    return this.groupVersionByAddress.get(address);
  }

  isGroupAddress(address: string) {
    return this.groupInfoByAddress.has(this.canonicalAddress(address));
  }

  getGroupInfo(address: string) {
    return this.groupInfoByAddress.get(this.canonicalAddress(address));
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

  // Явно убранные из контактов (иначе собеседник возвращался бы по правилу
  // «есть переписка»)
  private nonContactAddresses = new Set<string>();

  setContacts(added: string[], removed: string[] = []) {
    this.contactAddresses = new Set(added);
    this.nonContactAddresses = new Set(removed);
  }

  addContact(address: string) {
    this.contactAddresses.add(address);
    this.nonContactAddresses.delete(address);
  }

  removeContact(address: string) {
    this.contactAddresses.delete(address);
    this.nonContactAddresses.add(address);
  }

  getContactLists() {
    return { added: Array.from(this.contactAddresses), removed: Array.from(this.nonContactAddresses) };
  }

  isContact(address: string) {
    if (address === this.self) return false;
    if (this.nonContactAddresses.has(address)) return false;
    if (this.contactAddresses.has(address)) return true;
    if (this.kindByAddress.get(address) !== 'user') return false;
    const chatId = this.addressById.size ? this.getIdForAddress(address) : undefined;
    return Boolean(chatId && this.messagesByChatId.get(chatId)?.length);
  }

  setAvatar(address: string, fileId: string | undefined) {
    if (fileId) this.avatarByAddress.set(address, fileId);
    else this.avatarByAddress.delete(address);
  }

  getAvatar(address: string) {
    return this.avatarByAddress.get(address);
  }

  setProfile(address: string, fields: {
    bio?: string; birthday?: string; nameColor?: number;
    personalChannel?: string; phone?: string;
  }) {
    this.profileByAddress.set(address, fields);
  }

  getProfile(address: string) {
    return this.profileByAddress.get(address);
  }

  // Куда (в какой чат) кладётся сообщение с точки зрения этого клиента
  resolveChatAddress(message: WireStoredMessage): string {
    if (this.isGroupAddress(message.to)) return this.canonicalAddress(message.to);
    if (message.from && message.from !== this.self) return message.from;
    return message.to;
  }

  hasMessage(uuid: string) {
    return this.storedUuids.has(uuid);
  }

  getUuidForMessage(chatId: string, id: number) {
    return this.uuidByMsgKey.get(`${chatId}:${id}`);
  }

  getMessageByUuid(uuid: string): ApiMessage | undefined {
    const key = this.msgKeyByUuid.get(uuid);
    if (!key) return undefined;
    return this.messageByIdByChatId.get(key.chatId)?.get(key.id);
  }

  getMessage(chatId: string, id: number): ApiMessage | undefined {
    return this.messageByIdByChatId.get(chatId)?.get(id);
  }

  // Числовой id сообщения ВЫВОДИТСЯ ИЗ ВРЕМЕНИ (date в секундах → мс), чтобы
  // сортировка по id (как в tt) совпадала с сортировкой по времени. Иначе
  // подтянутая позже история (напр. журнал звонков) со старыми датами получала
  // бы большие «поздние» id и вставала в ленту после свежих сообщений (и ломала
  // isViewportNewest → стрелка ↓). id — целые (tt считает локальными только
  // дробные), уникальны в пределах чата, стабильны по uuid; всё in-memory и
  // пересоздаётся из sync на каждом входе, поэтому смена схемы безопасна.
  allocateMessageId(chatId: string, uuid: string, dateSecs?: number): number {
    const known = this.msgKeyByUuid.get(uuid);
    if (known) return known.id;
    const base = Math.floor((dateSecs || Math.floor(Date.now() / 1000)) * 1000);
    const used = this.usedMsgIdsByChatId.get(chatId) || new Set<number>();
    let id = base;
    while (used.has(id)) id++;
    used.add(id);
    this.usedMsgIdsByChatId.set(chatId, used);
    this.msgKeyByUuid.set(uuid, { chatId, id });
    this.uuidByMsgKey.set(`${chatId}:${id}`, uuid);
    return id;
  }

  putMessage(message: ApiMessage) {
    const uuid = this.uuidByMsgKey.get(`${message.chatId}:${message.id}`);
    if (uuid) this.storedUuids.add(uuid);
    const list = this.messagesByChatId.get(message.chatId) || [];
    let byId = this.messageByIdByChatId.get(message.chatId);
    if (!byId) {
      byId = new Map();
      this.messageByIdByChatId.set(message.chatId, byId);
    }
    if (byId.has(message.id)) {
      const index = this.indexOfId(list, message.id);
      if (index >= 0) list[index] = message;
    } else if (!list.length || list[list.length - 1].id < message.id) {
      list.push(message);
    } else {
      // Бинарная вставка в отсортированный по id список
      let low = 0;
      let high = list.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (list[mid].id < message.id) low = mid + 1;
        else high = mid;
      }
      list.splice(low, 0, message);
    }
    byId.set(message.id, message);
    this.messagesByChatId.set(message.chatId, list);
  }

  private indexOfId(list: ApiMessage[], id: number) {
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].id === id) return mid;
      if (list[mid].id < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  getMessages(chatId: string): ApiMessage[] {
    return this.messagesByChatId.get(chatId) || [];
  }

  removeMessage(chatId: string, id: number) {
    const uuid = this.uuidByMsgKey.get(`${chatId}:${id}`);
    if (uuid) this.storedUuids.delete(uuid);
    this.messageByIdByChatId.get(chatId)?.delete(id);
    const list = this.messagesByChatId.get(chatId);
    if (list) {
      const index = this.indexOfId(list, id);
      if (index >= 0) list.splice(index, 1);
    }
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
      isContact: !isSelf && this.isContact(address) ? true : undefined,
      // Premium-гейт tt (вставка кастом-эмодзи и т.п.) в Parvane снят: свой
      // юзер всегда premium; чужим не ставим, чтобы не рисовать бейджи
      isPremium: isSelf ? true : undefined,
      type: 'userTypeRegular',
      firstName: this.getDisplayName(address),
      // Username = local-part адреса: включает @-автокомплит и упоминания
      usernames: [{ username: address.split('@')[0], isActive: true, isEditable: false }],
      phoneNumber: this.profileByAddress.get(address)?.phone || '',
      color: {
        type: 'regular',
        color: this.profileByAddress.get(address)?.nameColor ?? (Number(id) % 7),
      },
      avatarPhotoId: this.avatarByAddress.get(address),
    };
  }

  // Упоминание == '@<local-part>' или полный '@адрес' в тексте сообщения
  isMentionOfSelf(message: ApiMessage) {
    const text = message.content.text?.text;
    if (!text || !this.self) return false;
    const localPart = this.self.split('@')[0];
    return text.includes(`@${this.self}`)
      || new RegExp(`@${localPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
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
    const selfMember = info.members.find(({ address }) => address === this.self);
    const selfRole = selfMember?.role;
    return {
      id: this.getIdForAddress(info.group_id, isChannel ? 'channel' : 'group'),
      type: isChannel ? 'chatTypeChannel' : 'chatTypeBasicGroup',
      title: info.name,
      isListed: true,
      isCreator: info.created_by === this.self ? true : undefined,
      // tt узнаёт админа только по adminRights: Manage-экраны, постинг в
      // канале, кнопки модерации. Права гранулярные (spec 003); legacy-админ
      // без явного набора от сервера приходит с полным
      adminRights: selfRole === 'admin' ? toAdminRights(selfMember?.admin_rights, isChannel) : undefined,
      // Права по умолчанию — только у групп: в канале пишут владелец и админы
      defaultBannedRights: !isChannel ? toBannedRights(info.default_permissions) : undefined,
      // Фото группы — открытый объект cloud, как аватар пользователя: tt
      // строит hash `avatar<id>?<file_id>`, провайдер отдаёт файл по file_id
      avatarPhotoId: info.avatar || undefined,
      membersCount: info.members.filter(({ role }) => role !== 'banned').length,
    };
  }

  unregisterGroup(address: string) {
    this.groupInfoByAddress.delete(address);
    this.groupVersionByAddress.delete(address);
  }

  buildApiMessage(stored: WireStoredMessage): ApiMessage {
    const chatAddress = this.resolveChatAddress(stored);
    const chatKind = this.kindByAddress.get(chatAddress) || 'user';
    const chatId = this.getIdForAddress(chatAddress, chatKind);
    const id = this.allocateMessageId(chatId, stored.id, stored.ts);
    const isOutgoing = stored.from === this.self;

    const replyKey = stored.reply_to ? this.msgKeyByUuid.get(stored.reply_to) : undefined;
    const isChatMode = stored.content.kind === 'chat_mode';

    return {
      id,
      chatId,
      content: isChatMode ? this.buildChatModeContent(stored, isOutgoing) : buildMessageContent(stored),
      date: stored.ts,
      // Служебное сообщение о режиме чата не шумит (без звука уведомления)
      isSilent: isChatMode ? true : undefined,
      isForwardingAllowed: true,
      isOutgoing,
      senderId: stored.from ? this.getIdForAddress(stored.from) : undefined,
      isEdited: stored.edited ? true : undefined,
      // Время последней правки — для «updated N min ago» у live-локации
      editDate: stored.edited && stored.updated_at ? stored.updated_at : undefined,
      isPinned: stored.pinned ? true : undefined,
      replyInfo: replyKey && replyKey.chatId === chatId
        ? { type: 'message', replyToMsgId: replyKey.id }
        : undefined,
      reactions: buildReactions(stored),
      forwardInfo: stored.content.forwarded_from ? {
        date: stored.ts,
        isChannelPost: false,
        fromChatId: this.getIdForAddress(stored.content.forwarded_from),
        hiddenUserName: stored.content.forwarded_name,
      } : undefined,
    };
  }

  // Режим «усиленная приватность» (L2, протокол v2): нативное служебное
  // сообщение чата — «{user} включил(а)…», своё — «Вы включили…»
  private buildChatModeContent(stored: WireStoredMessage, isOutgoing: boolean): ApiMessage['content'] {
    const key = CHAT_MODE_KEYS[isOutgoing ? 'own' : 'peer'][stored.content.l2 ? 'on' : 'off'];
    const template = this.getLangString?.(key) || CHAT_MODE_FALLBACK[key];
    return {
      action: {
        mediaType: 'action',
        type: 'customAction',
        message: template.replace('{user}', this.getDisplayName(stored.from)),
      },
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

// Карточка задания (spec 011) собирается из хранилища решений, которое
// живёт в провайдере; стор получает только функцию сборки
let resolveTaskOffer: (uuid: string) => ApiMessage['content']['taskOffer'] = () => undefined;

export function setTaskOfferResolver(resolve: typeof resolveTaskOffer) {
  resolveTaskOffer = resolve;
}

function buildMessageContent(stored: WireStoredMessage): ApiMessage['content'] {
  const { content, deleted, ts } = stored;
  if (deleted) {
    return { text: { text: '🗑 Сообщение удалено' } };
  }
  // Расшифровать не удалось (нет ключа/сессии, продвинутый ратчет). Раньше
  // такое сообщение просто не показывалось, и после исчерпания попыток
  // терялось насовсем — спека требует видимую заглушку, а не пустоту
  if (content.kind === 'encrypted' || content.kind === 'group_encrypted') {
    // Текст здесь захардкожен так же, как у ветки `deleted` выше: импорт
    // lang-провайдера в слой API тянет за собой UI-модули. Локализация
    // обеих заглушек — отдельной задачей
    return { text: { text: '🔒 Не удалось расшифровать сообщение' } };
  }
  const caption = content.caption ? { text: { text: content.caption } } : {};
  switch (content.kind) {
    case 'text':
      // Эмодзи-паки, приложенные к тексту: регистрируем ref — fetchCustomEmoji
      // подтянет архив из cloud и отдаст документы по docId из entities
      content.emoji_packs?.forEach((ref) => registerReceivedEmojiPackRef(ref, stored.from));
      return {
        text: { text: content.text || '', entities: wireEntitiesToApi(content.entities, (content.text || '').length) },
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
    case 'voice':
      // Waveform едет по проводу только Web↔Web; от desktop её нет —
      // бабл отрисует пустую волну
      return {
        ...caption,
        voice: {
          mediaType: 'voice',
          id: content.file_id!,
          duration: content.duration_secs || 1,
          waveform: content.waveform,
          size: content.size_bytes || 0,
        },
      };
    case 'video':
    case 'video_note': {
      const isRound = content.kind === 'video_note';
      return {
        ...(isRound ? {} : caption),
        video: {
          mediaType: 'video',
          id: content.file_id!,
          isRound: isRound || undefined,
          mimeType: content.mime || 'video/mp4',
          duration: content.duration_secs || 1,
          fileName: content.filename
            || `video-${(content.file_id || '').slice(0, 8)}${extForMime(content.mime) || '.mp4'}`,
          width: content.width || (isRound ? 384 : 640),
          height: content.height || (isRound ? 384 : 480),
          size: content.size_bytes || 0,
        },
      };
    }
    case 'file':
      // Аудиофайл — нативный плеер; duration/title/performer есть только от Web
      if (content.mime?.startsWith('audio/')) {
        return {
          ...caption,
          audio: {
            mediaType: 'audio',
            id: content.file_id!,
            size: content.size_bytes || 0,
            mimeType: content.mime,
            fileName: content.filename
              || `audio-${(content.file_id || '').slice(0, 8)}${extForMime(content.mime)}`,
            duration: content.duration_secs || 0,
            title: content.audio_title,
            performer: content.audio_performer,
          },
        };
      }
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
    case 'poll':
      return { pollId: stored.id };
    // spec 011 (TASK-1): карточка задания; ответ — текст со ссылкой на карточку
    case 'task_offer': {
      const taskOffer = resolveTaskOffer(stored.id);
      return taskOffer ? { taskOffer } : { text: { text: content.text || `📋 ${content.name || ''}` } };
    }
    case 'task_response':
      return { text: { text: content.text || (content.accepted ? '✅' : '❌') } };
    case 'location': {
      const geo = {
        lat: content.lat || 0, long: content.long || 0, accessHash: '0', accuracyRadius: content.accuracy,
      };
      return {
        location: content.live_period
          ? {
            mediaType: 'geoLive', geo, heading: content.heading, period: content.live_period,
          }
          : { mediaType: 'geo', geo },
      };
    }
    case 'sticker': {
      // pack_ref — стикер из кастомного набора: помечаем сет-ссылкой,
      // по клику на стикер модалка предложит установить весь пак
      const packSetId = content.pack_ref ? registerReceivedPackRef(content.pack_ref, stored.from) : undefined;
      return {
        sticker: {
          mediaType: 'sticker',
          id: content.file_id!,
          stickerSetInfo: { id: packSetId || 'parvane-builtin', accessHash: '0' },
          emoji: content.filename || '⭐',
          isLottie: content.mime === 'application/x-tgsticker',
          isVideo: content.mime === 'video/webm',
          width: content.width || 256,
          height: content.height || 256,
        },
      };
    }
    case 'gif':
      return {
        video: {
          mediaType: 'video',
          id: content.file_id!,
          mimeType: content.mime || 'video/webm',
          duration: content.duration_secs || 1,
          fileName: content.filename || 'animation.webm',
          width: content.width || 240,
          height: content.height || 240,
          isGif: true,
          supportsStreaming: false,
          size: content.size_bytes || 0,
          noSound: true,
        },
      };
    case 'unsupported':
      // Вид, который эта версия не знает (протокол v2, spec 007): пустое
      // содержимое — нативная заглушка Web A `MessageUnsupported`
      return {};
    case 'encrypted':
    case 'group_encrypted':
      // Сюда попадают sealed-сообщения без ключа этого устройства (например,
      // залогинились на новом устройстве — старые E2E прочитать нельзя)
      return { text: { text: '🔒 Зашифровано для другого устройства' } };
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

// ── права групп (spec 003): провод ↔ нативные типы Telegram Web A ────────────

// Применять ли сведения группы с ревизией `incoming` при известной `local`
// (conformance GROUP-1): равная — идемпотентно, старее — игнор
export function shouldApplyGroupInfo(local: number | undefined, incoming: number | undefined): boolean {
  if (local === undefined) return true;
  return (incoming ?? 0) >= local;
}

export const DEFAULT_GROUP_PERMISSIONS: Required<WireDefaultPermissions> = {
  send_messages: true,
  send_media: true,
  send_stickers_gifs: true,
  send_polls: true,
  embed_links: true,
  invite_users: true,
  pin_messages: false,
  change_info: false,
};

export function normalizePermissions(perms?: WireDefaultPermissions): Required<WireDefaultPermissions> {
  return { ...DEFAULT_GROUP_PERMISSIONS, ...(perms || {}) };
}

// Разрешения → запреты tt (`ApiChatBannedRights`: `true` = запрещено)
export function toBannedRights(perms?: WireDefaultPermissions): ApiChatBannedRights {
  const p = normalizePermissions(perms);
  const out: ApiChatBannedRights = {};
  if (!p.send_messages) {
    out.sendMessages = true;
    out.sendPlain = true;
  }
  if (!p.send_media) {
    out.sendMedia = true;
    out.sendPhotos = true;
    out.sendVideos = true;
    out.sendRoundvideos = true;
    out.sendAudios = true;
    out.sendVoices = true;
    out.sendDocs = true;
  }
  if (!p.send_stickers_gifs) {
    out.sendStickers = true;
    out.sendGifs = true;
  }
  if (!p.send_polls) out.sendPolls = true;
  if (!p.embed_links) out.embedLinks = true;
  if (!p.invite_users) out.inviteUsers = true;
  if (!p.pin_messages) out.pinMessages = true;
  if (!p.change_info) out.changeInfo = true;
  return out;
}

// Запреты tt → разрешения провода. Экран Permissions правит медиа группой
// (Send Media) — любой запрет внутри группы медиа выключает `send_media`.
// «Send Messages» на экране — это `sendPlain`; `sendMessages` tt выставляет
// сам как общий запрет (мы его дублируем в toBannedRights), поэтому обратно
// читаем только `sendPlain` — иначе снятый с экрана запрет не снимался
export function fromBannedRights(banned: ApiChatBannedRights): Required<WireDefaultPermissions> {
  const mediaBanned = Boolean(banned.sendMedia || banned.sendPhotos || banned.sendVideos
    || banned.sendRoundvideos || banned.sendAudios || banned.sendVoices || banned.sendDocs);
  return {
    send_messages: !banned.sendPlain,
    send_media: !mediaBanned,
    send_stickers_gifs: !(banned.sendStickers || banned.sendGifs),
    send_polls: !banned.sendPolls,
    embed_links: !banned.embedLinks,
    invite_users: !banned.inviteUsers,
    pin_messages: !banned.pinMessages,
    change_info: !banned.changeInfo,
  };
}

export const FULL_ADMIN_RIGHTS: Required<WireAdminRights> = {
  change_info: true,
  delete_messages: true,
  ban_users: true,
  invite_users: true,
  pin_messages: true,
  add_admins: true,
};

// Права админа провода → `ApiChatAdminRights`. Отсутствующий набор — полный
// (legacy). В канале админ ещё и публикует/правит посты (у Parvane это
// следствие роли, отдельного права нет)
export function toAdminRights(rights: WireAdminRights | undefined, isChannel = false): ApiChatAdminRights {
  const r = { ...FULL_ADMIN_RIGHTS, ...(rights || {}) };
  const out: ApiChatAdminRights = {};
  if (r.change_info) out.changeInfo = true;
  if (r.delete_messages) out.deleteMessages = true;
  if (r.ban_users) out.banUsers = true;
  if (r.invite_users) out.inviteUsers = true;
  if (r.pin_messages) out.pinMessages = true;
  if (r.add_admins) out.addAdmins = true;
  if (isChannel) {
    out.postMessages = true;
    out.editMessages = true;
  }
  return out;
}

// `ApiChatAdminRights` с экрана «Edit admin» → права провода; права вне
// контракта (anonymous, manageCall, stories, …) отбрасываются
export function toWireAdminRights(rights: ApiChatAdminRights): Required<WireAdminRights> {
  return {
    change_info: Boolean(rights.changeInfo),
    delete_messages: Boolean(rights.deleteMessages),
    ban_users: Boolean(rights.banUsers),
    invite_users: Boolean(rights.inviteUsers),
    pin_messages: Boolean(rights.pinMessages),
    add_admins: Boolean(rights.addAdmins),
  };
}
