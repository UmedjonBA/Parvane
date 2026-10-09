import type {
  ApiChat, ApiChatAdminRights, ApiChatBannedRights, ApiChatInviteImporter, ApiChatInviteInfo, ApiChatMember,
  ApiExportedInvite, ApiMessage, ApiPhoto, ApiUpdate, ApiUser,
} from '../types';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import type { createV2Controller, V2InviteRecord } from './v2/controller';
import type {
  WireDefaultPermissions, WireGroupInfo, WireGroupMember, WireMessageContent,
} from './wire';
import { MAIN_THREAD_ID } from '../types';

import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import {
  fromBannedRights, normalizePermissions, toAdminRights, toWireAdminRights,
} from './store';

// Сколько ждать секрет основной ссылки, созданной другим ведущим приглашения
const V2_PRIMARY_WAIT_MS = 10000;
const V2_PRIMARY_POLL_MS = 500;

export type InviteErrorCode =
  | 'invalid' | 'banned' | 'revoked' | 'expired' | 'exhausted' | 'declined' | 'requested'
  | 'rateLimited' | 'failed';

function isInviteManager(member?: WireGroupMember) {
  if (!member) return false;
  if (member.role === 'owner') return true;
  return member.role === 'admin' && toAdminRights(member.admin_rights).inviteUsers === true;
}

const MEDIA_KINDS = new Set(['photo', 'video', 'file', 'voice', 'video_note', 'audio']);
const STICKER_KINDS = new Set(['sticker', 'gif']);

// Права по типу содержимого проверяются только на клиентах (сервер видит
// шифртекст): отправитель без права не выберет тип в композере, получатель
// скрывает сообщение запрещённого типа от участника без роли (FR-009)
export function isContentAllowedForMember(perms: WireDefaultPermissions | undefined, content: WireMessageContent) {
  const p = normalizePermissions(perms);
  if (!p.send_messages) return false;
  if (!p.send_media && MEDIA_KINDS.has(content.kind)) return false;
  if (!p.send_stickers_gifs && STICKER_KINDS.has(content.kind)) return false;
  if (!p.send_polls && content.kind === 'poll') return false;
  if (!p.embed_links && content.kind === 'text') {
    if (content.webpage) return false;
    // Сущности на проводе — короткие имена (`url`, `text_url`), в API — длинные;
    // проверка должна ловить оба (WEB-06: ссылка-сущность проходила фильтр)
    const linkTypes = ['MessageEntityUrl', 'MessageEntityTextUrl', 'url', 'text_url'];
    if (content.entities?.some((e) => linkTypes.includes(e.type))) {
      return false;
    }
  }
  return true;
}

type GroupDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getStore: () => ParvaneStore;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
  // ApiPhoto из file_id открытого объекта cloud (фото группы в превью ссылки)
  buildAvatarPhoto?: (fileId: string) => ApiPhoto;
  // Протокол v2 (spec 007): группы с подписанным журналом состояния — других
  // групп нет (v1 отключён, T110); группы v1 в сторе — только история
  getV2?: () => V2Groups | undefined;
  // Шаблон служебного сообщения из языкового пакета (`{user}` — участник)
  getUnconfirmedTemplate?: () => string | undefined;
};

type V2Groups = ReturnType<typeof createV2Controller>;

// Mute «навсегда» в журнале группы v2: until_ms = 2^53 − 1 (0 — снять mute)
const V2_MUTE_FOREVER_MS = '9007199254740991';
const MS_IN_SECOND = 1000;

// Предел описания группы в символах (как у прежнего шарда messenger)
const GROUP_ABOUT_MAX_CHARS = 255;

/**
 * Основная ссылка группы: первая без названия, срока и лимита. Открытая — в приоритете; если её нет,
 * а есть такая же с одобрением, основная — она (группа «по заявке», spec 014), и открытая не создаётся.
 */
export function pickPrimaryInvite<T extends {
  title?: string; expiresAt?: number; usageLimit?: number; isRequestNeeded?: boolean;
}>(links: T[]): T | undefined {
  const plain = links.filter((link) => !link.title && !link.expiresAt && !link.usageLimit);
  return plain.find((link) => !link.isRequestNeeded) || plain[0];
}

export function createGroupController(deps: GroupDependencies) {
  // Незавершённые запросы основной ссылки — по одному на группу
  const v2PrimaryRequests = new Map<string, Promise<V2InviteRecord | undefined>>();

  function v2Of(address: string) {
    const v2 = deps.getV2?.();
    return v2?.isV2GroupAddress(address) ? v2 : undefined;
  }

  // Применить сведения группы. false — пришедшая ревизия старее известной
  // (GROUP-1), сведения пропущены. Группа v2: состав задаёт только журнал
  // (`isVerified`); сведения от сервера лишь сверяются с ним (FR-028, T080) —
  // участник, которого сервер показывает без подтверждённой записи
  // администратора, в состав не попадает и ключей не получает
  function register(info: WireGroupInfo, isVerified?: boolean): boolean {
    const store = deps.getStore();
    const v2 = v2Of(info.group_id);
    if (v2 && !isVerified) {
      v2.reportUnconfirmed(info.group_id, getActiveGroupMemberAddresses(info.members));
      const verified = v2.groupInfo(info.group_id);
      return verified ? register(verified, true) : false;
    }
    if (!store.registerGroup(info)) {
      const known = store.getGroupVersion(info.group_id);
      deps.log(`сведения группы ${info.group_id} v${info.version ?? 0} устарели (известна v${known}), пропущены`);
      return false;
    }
    return true;
  }

  // Сведения группы — только из её проверенного журнала (GROUP-3)
  function refresh(groupId: string) {
    const v2 = v2Of(groupId);
    if (!v2) return Promise.resolve(undefined);
    const verified = v2.groupInfo(groupId);
    if (verified) register(verified, true);
    return Promise.resolve(verified);
  }

  function buildMember(member: WireGroupMember): ApiChatMember {
    const store = deps.getStore();
    return {
      userId: store.getIdForAddress(member.address),
      isOwner: member.role === 'owner' ? true as const : undefined,
      isAdmin: member.role === 'admin' ? true as const : undefined,
      adminRights: member.role === 'admin' ? toAdminRights(member.admin_rights) : undefined,
      promotedByUserId: member.role === 'admin' && member.promoted_by
        ? store.getIdForAddress(member.promoted_by) : undefined,
    };
  }

  function buildFullInfo(info: WireGroupInfo) {
    const activeMembers = info.members.filter(({ role }) => role !== 'banned');
    const members = activeMembers.map(buildMember);
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    return {
      members,
      adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
      canViewMembers: true,
      about: info.about || undefined,
      requestsPending: info.pending_requests,
    };
  }

  // Новая для этого клиента группа (вступили по одобрению, добавили, догнали
  // нотисом): одного updateChat мало — без updateChatJoin и главного треда
  // tt не кладёт чат в список (см. refreshGroupsIfUnknownChat в sync.ts)
  // Порядок важен: сперва updateChatJoin снимает isNotJoined у чата, из
  // которого нас раньше удалили, — тогда следующий updateChat для нелистингового
  // чата зовёт loadTopChats и чат попадает в список; в обратном порядке
  // updateChatJoin для нелистингового чата ничего не добавляет
  function announceNewGroupChat(chatId: string) {
    deps.sendUpdate({ '@type': 'updateChatJoin', id: chatId });
  }

  function announceMainThread(chatId: string) {
    deps.sendUpdate({
      '@type': 'updateThreadInfo',
      threadInfo: { isCommentsInfo: false, chatId, threadId: MAIN_THREAD_ID },
    });
  }

  function pushGroupUpdates(info: WireGroupInfo, isNew = false) {
    const store = deps.getStore();
    const chat = store.buildApiChatForGroup(info);
    // Профиль читает участников из fullInfo — пользователей объявляем заранее
    info.members.filter(({ role }) => role !== 'banned').forEach((member) => {
      const user = store.buildApiUser(member.address);
      deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    });
    if (isNew) announceNewGroupChat(chat.id);
    deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
    if (isNew) announceMainThread(chat.id);
    deps.sendUpdate({ '@type': 'updateChatFullInfo', id: chat.id, fullInfo: buildFullInfo(info) });
  }

  // Группа с подписанным журналом (v2); все участники — v2-собеседники
  // `about` — описание из мастера канала; `isJoinRequestNeeded` — вступление по заявке (spec 014):
  // основная ссылка сразу создаётся с одобрением, открытая сама не появляется (`ensureV2Primary`)
  async function createGroupKind(
    title: string, users: ApiUser[], kind: 'group' | 'channel', about?: string, isJoinRequestNeeded?: boolean,
  ) {
    const v2 = deps.getV2?.();
    if (!deps.getConnection() || !v2?.isReady()) return undefined;
    const store = deps.getStore();
    const members = users.map((user) => store.getAddressForId(user.id)).filter(Boolean);
    try {
      const v2Info = await v2.createGroup(title, members, kind);
      if (!v2Info) return undefined;
      register(v2Info, true);
      if (about?.trim()) {
        await v2.setGroupInfo(v2Info.group_id, { about: about.trim() })
          .catch((error) => deps.log(`описание новой группы не сохранено: ${String(error)}`));
      }
      const v2Chat = store.buildApiChatForGroup(v2Info);
      deps.sendUpdate({ '@type': 'updateChat', id: v2Chat.id, chat: v2Chat });
      if (isJoinRequestNeeded) {
        // Создание занимает секунды; запрос основной ссылки (`ensureV2Primary`), пришедший в это
        // время, обязан дождаться его, а не создать открытую ссылку
        const address = v2Info.group_id;
        const request = v2.createInvite(address, { isRequestNeeded: true })
          .catch(() => undefined)
          .finally(() => v2PrimaryRequests.delete(address));
        v2PrimaryRequests.set(address, request);
        if (!(await request)) deps.log('ссылка с одобрением для новой группы не создана');
      }
      return v2Chat;
    } catch (error) {
      deps.log(`группа v2 не создана: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async function createGroupChat({ title, users, isJoinRequestNeeded }: {
    title: string; users: ApiUser[]; isJoinRequestNeeded?: boolean;
  }) {
    const chat = await createGroupKind(title, users, 'group', undefined, isJoinRequestNeeded);
    return chat ? { chat, missingUsers: [] } : undefined;
  }

  async function createChannel({
    title, about, users, isJoinRequestNeeded,
  }: { title: string; about?: string; users?: ApiUser[]; isJoinRequestNeeded?: boolean }) {
    const channel = await createGroupKind(title, users || [], 'channel', about, isJoinRequestNeeded);
    return channel ? { channel, missingUsers: [] } : undefined;
  }

  // Гранулярные права админа (spec 003): пустой набор — снять админа
  async function updateChatAdmin({ chat, user, adminRights }: {
    chat: ApiChat;
    user: ApiUser;
    adminRights?: ApiChatAdminRights;
  }) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const rights = adminRights ? toWireAdminRights(adminRights) : undefined;
    const isPromotion = Boolean(rights && Object.values(rights).some(Boolean));
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    const isDone = await v2.changeGroup(groupId, {
      set_role: {
        member: { address: member },
        role: isPromotion ? 'ROLE_ADMIN' : 'ROLE_MEMBER',
        rights: isPromotion ? rights : {},
      },
    });
    return isDone || undefined;
  }

  // Parvane-группы не мигрируют в супергруппы — tt зовёт это перед
  // promote/demote, отдаём чат как есть
  function migrateChat(chat: ApiChat) {
    return chat;
  }

  async function updateChatTitle(chat: ApiChat, title: string) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    return (await v2.setGroupInfo(groupId, { name: title })) || undefined;
  }

  // Описание и фото (group.setinfo): владелец, админ с change_info, участник
  // с change_info в правах по умолчанию
  async function setGroupInfo(
    groupId: string,
    patch: { about?: string; avatarFileId?: string; clearAvatar?: boolean },
  ) {
    const v2 = v2Of(groupId);
    const current = v2?.groupInfo(groupId);
    if (!v2 || !current) return false;
    // Схема v2 меряет описание байтами (1024) — предел в символах держит
    // клиент, чтобы поведение экрана было одним у всех клиентов
    if (patch.about !== undefined && [...patch.about].length > GROUP_ABOUT_MAX_CHARS) {
      deps.log(`описание группы длиннее ${GROUP_ABOUT_MAX_CHARS} символов — отклонено`);
      return false;
    }
    return v2.setGroupInfo(groupId, {
      about: patch.about,
      avatarFileId: patch.clearAvatar ? '' : (patch.avatarFileId || undefined),
    });
  }

  async function updateChatAbout(chat: ApiChat, about: string) {
    const groupId = deps.getStore().getAddressForId(chat.id);
    if (!groupId) return undefined;
    return (await setGroupInfo(groupId, { about })) || undefined;
  }

  async function updateChatDefaultBannedRights({ chat, bannedRights }: {
    chat: ApiChat;
    bannedRights: ApiChatBannedRights;
  }) {
    const groupId = deps.getStore().getAddressForId(chat.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    const isDone = await v2.changeGroup(groupId, {
      set_permissions: { default_permissions: fromBannedRights(bannedRights) },
    });
    return isDone || undefined;
  }

  async function leaveGroup(chatId: string) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chatId);
    if (!groupId) return undefined;
    // Группа v2 — записью журнала; группа v1 (история) — снять локально
    const v2 = v2Of(groupId);
    if (v2 && !(await v2.changeGroup(groupId, { leave: {} }))) return undefined;
    store.unregisterGroup(groupId);
    deps.sendUpdate({ '@type': 'updateChatLeave', id: chatId });
    return true;
  }

  async function deleteGroup(chatId: string) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chatId);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (v2 && !(await v2.changeGroup(groupId, { delete_group: {} }))) return undefined;
    store.unregisterGroup(groupId);
    deps.sendUpdate({ '@type': 'updateChatLeave', id: chatId });
    return true;
  }

  async function fetchFullChat(chat: ApiChat) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    const address = store.getAddressForId(chat.id);
    if (!connection || !address) return undefined;
    if (!store.isGroupAddress(address)) {
      return { fullInfo: { canViewMembers: false }, chats: [], userStatusesById: {} };
    }
    const v2 = v2Of(address);
    const info = v2?.groupInfo(address) || store.getGroupInfo(address);
    if (!info) return undefined;
    if (v2) register(info, true);
    const members = buildMembers(info.members.filter(({ role }) => role !== 'banned'));
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    const selfMember = info.members.find(({ address: member }) => member === store.self);
    const inviteLink = v2 && isInviteManager(selfMember) ? (await ensureV2Primary(v2, address))?.url : undefined;
    return {
      fullInfo: {
        members,
        adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
        canViewMembers: true,
        inviteLink,
        about: info.about || undefined,
      },
      chats: [store.buildApiChatForGroup(info)],
      userStatusesById: {},
      membersCount: members.length,
    };
  }

  // Основная ссылка группы v2: первая без параметров, созданная этим
  // устройством (секрет ссылки есть только у создателя); нет — создаём
  async function ensureV2Primary(v2: V2Groups, address: string) {
    const inFlight = v2PrimaryRequests.get(address);
    if (inFlight) return inFlight;
    const findPrimary = async () => pickPrimaryInvite(await v2.listInvites(address));
    const request = (async () => {
      let primary = await findPrimary();
      // Основную ссылку уже создал другой ведущий приглашения, а её секрет ещё в
      // пути (служебная раздача) — ждём его, а не плодим вторую основную
      for (let waited = 0; !primary && waited < V2_PRIMARY_WAIT_MS && await v2.hasPendingPrimary(address);
        waited += V2_PRIMARY_POLL_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, V2_PRIMARY_POLL_MS);
        });
        primary = await findPrimary();
      }
      return primary || v2.createInvite(address, {});
    })().finally(() => v2PrimaryRequests.delete(address));
    v2PrimaryRequests.set(address, request);
    return request;
  }

  // Ссылка v2 сравнивается по адресу до секрета: отозванная чужая показывается без него
  function isSameV2Link(left: string, right: string) {
    const strip = (url: string) => url.replace(/^https?:\/\//, '').split('#')[0];
    return strip(left) === strip(right);
  }

  function buildV2ExportedInvite(record: V2InviteRecord, isPrimary?: boolean, isRevoked?: boolean): ApiExportedInvite {
    return {
      link: record.url,
      date: record.date,
      title: record.title,
      isPermanent: isPrimary ? true : undefined,
      isRevoked: isRevoked ? true : undefined,
      expireDate: record.expiresAt,
      usageLimit: record.usageLimit,
      usage: record.usage,
      isRequestNeeded: record.isRequestNeeded,
      adminId: deps.selfId(),
    };
  }

  // FR-028 (T080): нативное служебное сообщение в чате группы — участник без
  // подтверждённой записи администратора ключей не получает
  function announceUnconfirmed(address: string, members: string[]) {
    const store = deps.getStore();
    if (!store.isGroupAddress(address)) return;
    const chatId = store.getIdForAddress(address, 'group');
    const ts = Math.floor(Date.now() / MS_IN_SECOND);
    const template = deps.getUnconfirmedTemplate?.()
      || '{user} is listed by the server, but no admin record confirms it. Encryption keys are not shared with them.';
    members.forEach((member) => {
      const id = store.allocateMessageId(chatId, `unconfirmed:${address}:${member}`, ts);
      const message: ApiMessage = {
        id,
        chatId,
        date: ts,
        isOutgoing: false,
        content: {
          action: {
            mediaType: 'action',
            type: 'customAction',
            message: template.replace('{user}', store.getDisplayName(member)),
          },
        },
      };
      store.putMessage(message);
      deps.sendUpdate({ '@type': 'newMessage', chatId, id, message });
    });
  }

  function registerCachedV2() {
    deps.getV2?.()?.cachedGroups().forEach((info) => register(info, true));
  }

  // Группа v2 изменилась по журналу (из v2-контроллера)
  function applyV2Group(info: WireGroupInfo, isNew: boolean) {
    if (register(info, true)) pushGroupUpdates(info, isNew);
  }

  function removeV2Group(address: string) {
    const store = deps.getStore();
    store.unregisterGroup(address);
    deps.sendUpdate({ '@type': 'updateChatLeave', id: store.getIdForAddress(address, 'group') });
  }

  // Участники группы для нативных экранов: пользователи отправляются апдейтом
  function buildMembers(list: WireGroupInfo['members']) {
    const store = deps.getStore();
    list.forEach((member) => {
      const user = store.buildApiUser(member.address);
      deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    });
    return list.map(buildMember);
  }

  // Список участников (канал/поиск/админы/заблокированные) из group.info:
  // отдельной пагинации на сервере нет — фильтруем состав целиком
  async function fetchMembers({
    chat, memberFilter = 'recent', offset = 0, query,
  }: {
    chat: ApiChat;
    memberFilter?: 'recent' | 'kicked' | 'admin' | 'search';
    offset?: number;
    query?: string;
  }) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    const info = await refresh(groupId).catch(() => undefined) || store.getGroupInfo(groupId);
    if (!info) return undefined;
    const needle = (query || '').trim().toLowerCase();
    const selected = info.members.filter(({ address, role }) => {
      switch (memberFilter) {
        case 'kicked':
          return role === 'banned';
        case 'admin':
          return role === 'owner' || role === 'admin';
        case 'search':
          return role !== 'banned' && (!needle || address.toLowerCase().includes(needle)
            || store.getDisplayName(address).toLowerCase().includes(needle));
        default:
          return role !== 'banned';
      }
    });
    return { members: buildMembers(selected).slice(offset), userStatusesById: {} };
  }

  // ── инвайт-ссылки ──────────────────────────────────────────────────────────

  async function getSelfMember(groupId: string) {
    const store = deps.getStore();
    const info = store.getGroupInfo(groupId) || await refresh(groupId).catch(() => undefined);
    return info?.members.find(({ address }) => address === store.self);
  }

  async function addChatMembers(chat: ApiChat, users: ApiUser[]) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    for (const user of users) {
      const member = store.getAddressForId(user.id);
      if (!member) continue;
      // Добавить в группу v2 можно только v2-собеседника (ключи эпохи — по v2)
      if (!(await v2.isV2Chat(member).catch(() => false))) return undefined;
      if (!(await v2.changeGroup(groupId, { add_member: { member: { address: member } } }))) return undefined;
    }
    await refresh(groupId);
    return true;
  }

  async function deleteChatMember(chat: ApiChat, user: ApiUser) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    return (await v2.changeGroup(groupId, { remove_member: { member: { address: member } } })) || undefined;
  }

  async function updateChatMemberBannedRights({
    chat, user, bannedRights, untilDate,
  }: {
    chat: ApiChat;
    user: ApiUser;
    bannedRights: Record<string, unknown>;
    untilDate?: number;
  }) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    const ref = { member: { address: member } };
    let change: Record<string, unknown>;
    if (bannedRights.viewMessages) {
      change = { ban: ref };
    } else if (bannedRights.sendMessages) {
      change = { mute: { ...ref, until_ms: untilDate ? String(untilDate * MS_IN_SECOND) : V2_MUTE_FOREVER_MS } };
    } else {
      const isBanned = v2.groupInfo(groupId)?.members.some(
        ({ address, role }) => address === member && role === 'banned',
      );
      change = isBanned ? { unban: ref } : { mute: { ...ref, until_ms: '0' } };
    }
    return (await v2.changeGroup(groupId, change)) || undefined;
  }

  // «Создать ссылку»: с параметрами — дополнительная; без — основная группы
  async function exportChatInvite({
    peer, title, expireDate, usageLimit, isRequestNeeded,
  }: {
    peer: ApiChat; title?: string; expireDate?: number; usageLimit?: number; isRequestNeeded?: boolean;
  }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!groupId) return undefined;
    const selfMember = await getSelfMember(groupId);
    if (!isInviteManager(selfMember)) return undefined;
    const hasParams = Boolean(title || expireDate || usageLimit || isRequestNeeded);
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    const record = hasParams
      ? await v2.createInvite(groupId, {
        title, expireDate, usageLimit, isRequestNeeded,
      })
      : await ensureV2Primary(v2, groupId);
    return record ? buildV2ExportedInvite(record, !hasParams) : undefined;
  }

  // Экран «Пригласительные ссылки»: список сервера (активные/истёкшие/
  // исчерпанные или отозванные); без основной ссылки — создаём её
  async function fetchExportedChatInvites({ peer, isRevoked }: {
    peer: ApiChat;
    admin?: unknown;
    isRevoked?: boolean;
    limit?: number;
  }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!groupId) return { invites: [] };
    const selfMember = await getSelfMember(groupId);
    if (!isInviteManager(selfMember)) return { invites: [] };
    const v2 = v2Of(groupId);
    if (!v2) return { invites: [] };
    // Отозванные ссылки v2 помнит сервер, пока админ их не удалит
    if (isRevoked) {
      const revoked = await v2.listRevokedInvites(groupId);
      return { invites: revoked.map((record) => buildV2ExportedInvite(record, false, true)) };
    }
    const primary = await ensureV2Primary(v2, groupId);
    const links = await v2.listInvites(groupId);
    // Заявки сервер отдаёт общим списком группы — счётчик показываем на
    // ссылках с одобрением
    const hasApproval = links.some((record) => record.isRequestNeeded);
    const requested = hasApproval ? (await v2.listJoinRequests(groupId))?.length : undefined;
    return {
      invites: links.map((record) => ({
        ...buildV2ExportedInvite(record, record.url === primary?.url),
        requested: (record.isRequestNeeded && requested) || undefined,
      })),
    };
  }

  // Сервер не правит параметры ссылки — экран tt зовёт это для отзыва
  // (`isRevoked: true`); остальные правки — «отзови и создай новую»
  async function editExportedChatInvite({ peer, link, isRevoked }: {
    peer: ApiChat; link: string; isRevoked?: boolean;
    expireDate?: number; usageLimit?: number; isRequestNeeded?: boolean; title?: string;
  }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    const v2 = groupId ? v2Of(groupId) : undefined;
    if (!v2 || !groupId) return undefined;
    if (!isRevoked) {
      reportInviteError('editUnsupported');
      return undefined;
    }
    const record = (await v2.listInvites(groupId)).find((item) => item.url === link);
    if (!record || !(await v2.revokeInvite(groupId, link))) return undefined;
    return { oldInvite: buildV2ExportedInvite(record), newInvite: buildV2ExportedInvite(record, false, true) };
  }

  async function deleteExportedChatInvite({ peer, link }: { peer: ApiChat; link: string }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    const v2 = groupId ? v2Of(groupId) : undefined;
    if (!v2 || !groupId) return undefined;
    const revoked = (await v2.listRevokedInvites(groupId)).find((record) => isSameV2Link(record.url, link));
    if (!revoked) return true; // уже удалена
    return (await v2.deleteRevokedInvite(groupId, revoked.linkId)) ? true : undefined;
  }

  async function deleteRevokedExportedChatInvites({ peer }: { peer: ApiChat; admin?: unknown }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    for (const record of await v2.listRevokedInvites(groupId)) {
      await v2.deleteRevokedInvite(groupId, record.linkId);
    }
    return true;
  }

  // Вступившие по ссылке сервер не хранит (только счётчик) — список пуст;
  // заявители (`isRequested`) — из заявок группы
  async function fetchChatInviteImporters({ peer, isRequested }: {
    peer: ApiChat; link?: string; offsetDate?: number; offsetUser?: ApiUser; limit?: number; isRequested?: boolean;
  }): Promise<{ importers: ApiChatInviteImporter[] } | undefined> {
    const store = deps.getStore();
    const groupId = store.getAddressForId(peer.id);
    if (!groupId) return undefined;
    if (!isRequested) return { importers: [] };
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    // Сервер v2 не сообщает, по какой ссылке пришла заявка, — список общий
    const pending = await v2.listJoinRequests(groupId);
    if (!pending) return undefined;
    return {
      importers: pending.map((request) => {
        const user = store.buildApiUser(request.user);
        deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
        return { userId: user.id, date: request.date, isRequested: true as const };
      }),
    };
  }

  async function hideChatJoinRequest(
    { peer, user, isApproved }: { peer: ApiChat; user: ApiUser; isApproved: boolean },
  ) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(peer.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    return (await v2.decideJoinRequest(groupId, member, isApproved)) ? true : undefined;
  }

  async function hideAllChatJoinRequests(
    { peer, isApproved }: { peer: ApiChat; isApproved: boolean; link?: string },
  ) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(peer.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (!v2) return undefined;
    const pending = await v2.listJoinRequests(groupId);
    if (!pending) return undefined;
    for (const request of pending) {
      await v2.decideJoinRequest(groupId, request.user, isApproved);
    }
    return true;
  }

  function reportInviteError(code: InviteErrorCode | 'editUnsupported' | 'linkFailed') {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('parvane-invite-error', { detail: { code } }));
  }

  // Превью ссылки до вступления: нативная модалка «Join group» с именем, фото,
  // числом участников и «Request to Join»; участнику — сразу чат;
  // недействительная — тост с причиной. Ссылка v2 —
  // `https://<домен>/join/<link_id>#<секрет>`: превью по link_id (секрет серверу
  // не уходит); прежние ссылки `#+<токен>` (группы v1) больше не действуют
  async function checkChatInvite(hash: string) {
    const v2 = deps.getV2?.();
    if (!v2?.isV2InviteUrl(hash)) {
      reportInviteError('invalid');
      return undefined;
    }
    const check = await v2.checkInvite(hash);
    if (!check) {
      reportInviteError('invalid');
      return undefined;
    }
    if ('error' in check) {
      reportInviteError(check.error.status === 'error' ? check.error.code : 'failed');
      return undefined;
    }
    const invite: ApiChatInviteInfo = {
      title: check.name,
      about: check.about,
      photo: check.avatar && deps.buildAvatarPhoto ? deps.buildAvatarPhoto(check.avatar) : undefined,
      participantsCount: check.membersCount,
      isRequestNeeded: check.isRequestNeeded ? true : undefined,
      isChannel: check.isChannel ? true : undefined,
      isBroadcast: check.isChannel ? true : undefined,
      color: 0,
    };
    const info = check.isMember ? v2.groupInfo(check.address) : undefined;
    if (info) {
      register(info, true);
      const chat = deps.getStore().buildApiChatForGroup(info);
      deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
      return { invite, chat, users: [] };
    }
    return { invite, users: [] };
  }

  // Формат ответа — как у апстрим-экшена acceptChatInvite: { type: 'ok', chat }.
  // Отказ (бан, отозвана, истекла, исчерпана, отклонена, сеть) — событие для
  // тоста; заявка «по одобрению» — pending без чата (тост показывает tt)
  async function importChatInvite({ hash }: { hash: string }) {
    const v2 = deps.getV2?.();
    if (!v2?.isV2InviteUrl(hash)) {
      reportInviteError('invalid');
      return undefined;
    }
    const result = await v2.joinByInvite(hash);
    if (!result) {
      reportInviteError('invalid');
      return undefined;
    }
    if (result.status === 'requested') return { type: 'requested' as const };
    if (result.status === 'error') {
      reportInviteError(result.code);
      return undefined;
    }
    register(result.info, true);
    pushGroupUpdates(result.info, true);
    const groupChat = deps.getStore().buildApiChatForGroup(result.info);
    return { type: 'ok' as const, chat: groupChat };
  }

  return {
    announceUnconfirmed,
    applyV2Group,
    registerCachedV2,
    removeV2Group,
    addChatMembers,
    checkChatInvite,
    createChannel,
    createGroupChat,
    deleteChatMember,
    deleteExportedChatInvite,
    deleteGroup,
    deleteRevokedExportedChatInvites,
    editExportedChatInvite,
    exportChatInvite,
    fetchChatInviteImporters,
    fetchExportedChatInvites,
    fetchFullChat,
    fetchMembers,
    hideAllChatJoinRequests,
    hideChatJoinRequest,
    importChatInvite,
    leaveGroup,
    migrateChat,
    pushGroupUpdates,
    refresh,
    register,
    setGroupInfo,
    updateChatAbout,
    updateChatAdmin,
    updateChatDefaultBannedRights,
    updateChatMemberBannedRights,
    updateChatTitle,
  };
}
