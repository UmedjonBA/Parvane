import type { ApiChat, ApiUpdate, ApiUser } from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import {
  TOPIC_GROUP_ADD_MEMBER,
  TOPIC_GROUP_BAN,
  TOPIC_GROUP_CREATE,
  TOPIC_GROUP_DELETE,
  TOPIC_GROUP_INFO,
  TOPIC_GROUP_INVITE_CREATE,
  TOPIC_GROUP_JOIN,
  TOPIC_GROUP_LIST,
  TOPIC_GROUP_MUTE,
  TOPIC_GROUP_REMOVE_MEMBER,
  TOPIC_GROUP_RENAME,
  TOPIC_GROUP_SET_ROLE,
  TOPIC_GROUP_UNBAN,
  type WireGroupInfo,
} from './wire';

export type InviteLinkRecord = { link: string; date: number };

export type InviteErrorCode = 'invalid' | 'banned' | 'rateLimited' | 'failed';

// Точные тексты отказа шарда messenger на group.join
// (backend/shards/messenger/src/main.rs, обработчик group.join)
export function mapJoinError(error?: string): InviteErrorCode {
  if (error === 'ссылка недействительна') return 'invalid';
  if (error === 'вы забанены в этой группе') return 'banned';
  // Шард может отказать по лимиту запросов — у этого отказа свой понятный текст
  if (error?.includes('rate_limited')) return 'rateLimited';
  return 'failed';
}

function isInviteManager(role?: string) {
  return role === 'owner' || role === 'admin';
}

// Ссылка-приглашение в форме, которую понимают и клик в сообщении, и вставка
// адреса в браузер: `<origin><path>#+<токен>` (см. util/routing.ts)
export function buildInviteLink(token: string) {
  if (typeof window === 'undefined') return `#+${token}`;
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#+${token}`;
}

type GroupDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  onGroupRegistered: (groupChatId: string) => void;
  log: (message: string) => void;
  // Постоянная ссылка группы переживает перезагрузку: сервер не умеет отдать
  // уже созданный токен и не умеет отзывать, новый токен на каждую сессию
  // плодил бы неотзываемые ссылки
  loadInviteLink?: (groupId: string) => InviteLinkRecord | undefined;
  saveInviteLink?: (groupId: string, record: InviteLinkRecord) => void;
  forgetInviteLink?: (groupId: string) => void;
};

export function createGroupController(deps: GroupDependencies) {
  const inviteLinkByGroupId = new Map<string, InviteLinkRecord>();
  // Незавершённые запросы создания ссылки — по одному на группу
  const inviteRequestByGroupId = new Map<string, Promise<InviteLinkRecord | undefined>>();

  function register(info: WireGroupInfo) {
    const store = deps.getStore();
    store.registerGroup(info);
    // Подписка на typing-топик группы (msg.typing.<groupChatId>) — иначе
    // «печатает…» в группе никто не услышит
    deps.onGroupRegistered(store.getIdForAddress(info.group_id, 'group'));
    const e2e = deps.getE2e();
    if (!e2e || !store.self) return;
    const activeMembers = getActiveGroupMemberAddresses(info.members);
    if (e2e.syncGroupRecipients(info.group_id, activeMembers, store.self)) {
      deps.log(`состав ${info.group_id} сократился, групповой ключ ротирован`);
    }
  }

  function registerExclusion(groupId: string, member: string, banned: boolean) {
    const store = deps.getStore();
    const info = store.getGroupInfo(groupId);
    if (!info) {
      deps.getE2e()?.rotateGroup(groupId);
      return;
    }
    const hasMember = info.members.some(({ address }) => address === member);
    const members = banned
      ? info.members.map((entry) => (
        entry.address === member ? { ...entry, role: 'banned' } : entry
      ))
      : info.members.filter(({ address }) => address !== member);
    if (banned && !hasMember) members.push({ address: member, role: 'banned' });
    register({ ...info, members });
  }

  async function refresh(groupId: string) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const raw = await connection.request(
      TOPIC_GROUP_INFO,
      JSON.stringify({ token: deps.getToken(), group_id: groupId }),
    );
    const info = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups?.[0];
    if (info) register(info);
    return info;
  }

  function buildFullInfo(info: WireGroupInfo) {
    const store = deps.getStore();
    const activeMembers = info.members.filter(({ role }) => role !== 'banned');
    const members = activeMembers.map((member) => ({
      userId: store.getIdForAddress(member.address),
      isOwner: member.role === 'owner' ? true as const : undefined,
      isAdmin: member.role === 'admin' ? true as const : undefined,
    }));
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    return {
      members,
      adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
      canViewMembers: true,
    };
  }

  function pushGroupUpdates(info: WireGroupInfo) {
    const store = deps.getStore();
    const chat = store.buildApiChatForGroup(info);
    deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
    deps.sendUpdate({ '@type': 'updateChatFullInfo', id: chat.id, fullInfo: buildFullInfo(info) });
  }

  async function refreshMemberships() {
    const connection = deps.getConnection();
    if (!connection) return;
    try {
      const raw = await connection.request(
        TOPIC_GROUP_LIST,
        JSON.stringify({ token: deps.getToken() }),
      );
      const groups = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups || [];
      const store = deps.getStore();
      const listed = new Set(groups.map((info) => info.group_id));
      groups.forEach((info) => {
        // Изменения имени/состава/ролей должны сходиться на всех клиентах
        // без full reload; новые группы — попадать в список чатов
        const previous = store.getGroupInfo(info.group_id);
        register(info);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(info)) {
          pushGroupUpdates(info);
        }
      });
      // Исчезнувшие группы: удалены владельцем либо нас выгнали
      store.getGroupAddresses()
        .filter((address) => !listed.has(address))
        .forEach((address) => {
          store.unregisterGroup(address);
          deps.sendUpdate({ '@type': 'updateChatLeave', id: store.getIdForAddress(address) });
        });
    } catch {
      // Следующий delta-sync повторит membership refresh.
    }
  }

  async function createGroupKind(title: string, users: ApiUser[], kind: 'group' | 'channel') {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const store = deps.getStore();
    const members = users.map((user) => store.getAddressForId(user.id)).filter(Boolean);
    const raw = await connection.request(TOPIC_GROUP_CREATE, JSON.stringify({
      token: deps.getToken(), name: title, kind, members,
    }));
    const response = JSON.parse(raw) as { ok: boolean; group_id?: string; error?: string };
    if (!response.ok || !response.group_id) return undefined;

    const info: WireGroupInfo = {
      group_id: response.group_id,
      name: title,
      kind,
      created_by: store.self,
      members: [
        { address: store.self, role: 'owner' },
        ...members.map((address) => ({ address, role: 'member' })),
      ],
    };
    register(info);
    const chat = store.buildApiChatForGroup(info);
    deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
    return chat;
  }

  async function createGroupChat({ title, users }: { title: string; users: ApiUser[] }) {
    const chat = await createGroupKind(title, users, 'group');
    return chat ? { chat, missingUsers: [] } : undefined;
  }

  async function createChannel({ title, users }: { title: string; users?: ApiUser[] }) {
    const channel = await createGroupKind(title, users || [], 'channel');
    return channel ? { channel, missingUsers: [] } : undefined;
  }

  async function updateChatAdmin({ chat, user, adminRights }: {
    chat: ApiChat;
    user: ApiUser;
    adminRights?: Record<string, boolean | undefined>;
  }) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const isPromotion = Boolean(adminRights && Object.values(adminRights).some(Boolean));
    const raw = await connection.request(TOPIC_GROUP_SET_ROLE, JSON.stringify({
      token: deps.getToken(),
      group_id: groupId,
      member,
      role: isPromotion ? 'admin' : 'member',
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
  }

  // Parvane-группы не мигрируют в супергруппы — tt зовёт это перед
  // promote/demote, отдаём чат как есть
  function migrateChat(chat: ApiChat) {
    return chat;
  }

  async function updateChatTitle(chat: ApiChat, title: string) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    const raw = await connection.request(TOPIC_GROUP_RENAME, JSON.stringify({
      token: deps.getToken(), group_id: groupId, name: title,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
  }

  async function leaveGroup(chatId: string) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chatId);
    if (!groupId) return undefined;
    const raw = await connection.request(TOPIC_GROUP_REMOVE_MEMBER, JSON.stringify({
      token: deps.getToken(), group_id: groupId, member: store.self,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    forgetInviteLink(groupId);
    store.unregisterGroup(groupId);
    deps.sendUpdate({ '@type': 'updateChatLeave', id: chatId });
    return true;
  }

  async function deleteGroup(chatId: string) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chatId);
    if (!groupId) return undefined;
    const raw = await connection.request(TOPIC_GROUP_DELETE, JSON.stringify({
      token: deps.getToken(), group_id: groupId,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    forgetInviteLink(groupId);
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

    const raw = await connection.request(
      TOPIC_GROUP_INFO,
      JSON.stringify({ token: deps.getToken(), group_id: address }),
    );
    const info = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups?.[0];
    if (!info) return undefined;
    register(info);

    const members = buildMembers(info.members.filter(({ role }) => role !== 'banned'));
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    const selfRole = info.members.find(({ address: member }) => member === store.self)?.role;
    const inviteLink = (await ensureInviteRecord(address, selfRole))?.link;
    return {
      fullInfo: {
        members,
        adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
        canViewMembers: true,
        inviteLink,
      },
      chats: [store.buildApiChatForGroup(info)],
      userStatusesById: {},
      membersCount: members.length,
    };
  }

  // Участники группы для нативных экранов: пользователи отправляются апдейтом
  function buildMembers(list: WireGroupInfo['members']) {
    const store = deps.getStore();
    list.forEach((member) => {
      const user = store.buildApiUser(member.address);
      deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    });
    return list.map((member) => ({
      userId: store.getIdForAddress(member.address),
      isOwner: member.role === 'owner' ? true as const : undefined,
      isAdmin: member.role === 'admin' ? true as const : undefined,
    }));
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

  // Постоянная инвайт-ссылка группы для владельца/админа. Порядок: память
  // сессии → сохранённая на устройстве → group.invite.create (шард создаёт
  // новый неотзываемый токен на каждый запрос). Ошибка сети не должна ронять
  // fetchFullChat — ссылки просто нет
  async function ensureInviteRecord(groupId: string, selfRole?: string) {
    if (!isInviteManager(selfRole)) return undefined;
    const cached = inviteLinkByGroupId.get(groupId);
    if (cached) return cached;
    const persisted = deps.loadInviteLink?.(groupId);
    if (persisted) {
      inviteLinkByGroupId.set(groupId, persisted);
      return persisted;
    }
    // Кэш пишется только ПОСЛЕ await, поэтому без этого замка конкурентные
    // fetchFullChat и fetchExportedChatInvites при первом открытии группы
    // создавали на сервере два вечных токена (SC-002)
    const inFlight = inviteRequestByGroupId.get(groupId);
    if (inFlight) return inFlight;
    const request = createInviteRecord(groupId).finally(() => {
      inviteRequestByGroupId.delete(groupId);
    });
    inviteRequestByGroupId.set(groupId, request);
    return request;
  }

  async function createInviteRecord(groupId: string) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_GROUP_INVITE_CREATE, JSON.stringify({
        token: deps.getToken(), group_id: groupId,
      }));
      const response = JSON.parse(raw) as { ok: boolean; invite?: string };
      if (!response.ok || !response.invite) return undefined;
      // Ссылку выдаём в той же форме, которую понимает адресная строка
      // (`<origin>/#+<токен>`, util/routing.ts): прежняя `parvane.invite/<токен>`
      // работала только по клику внутри клиента, а вставка её в адрес браузера
      // никуда не вела — домена нет (FR-012)
      const record = { link: buildInviteLink(response.invite), date: Math.floor(Date.now() / 1000) };
      inviteLinkByGroupId.set(groupId, record);
      deps.saveInviteLink?.(groupId, record);
      return record;
    } catch (error) {
      deps.log(`инвайт-ссылка ${groupId} не получена: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  function forgetInviteLink(groupId: string) {
    inviteLinkByGroupId.delete(groupId);
    deps.forgetInviteLink?.(groupId);
  }

  async function getSelfRole(groupId: string) {
    const store = deps.getStore();
    const info = store.getGroupInfo(groupId) || await refresh(groupId).catch(() => undefined);
    return info?.members.find(({ address }) => address === store.self)?.role;
  }

  function buildExportedInvite(record: InviteLinkRecord) {
    return {
      link: record.link,
      date: record.date,
      isPermanent: true as const,
      adminId: deps.selfId(),
    };
  }

  async function addChatMembers(chat: ApiChat, users: ApiUser[]) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    for (const user of users) {
      const member = store.getAddressForId(user.id);
      if (!member) continue;
      const raw = await connection.request(TOPIC_GROUP_ADD_MEMBER, JSON.stringify({
        token: deps.getToken(), group_id: groupId, member,
      }));
      if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    }
    await refresh(groupId);
    return true;
  }

  async function deleteChatMember(chat: ApiChat, user: ApiUser) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const raw = await connection.request(TOPIC_GROUP_REMOVE_MEMBER, JSON.stringify({
      token: deps.getToken(), group_id: groupId, member,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    registerExclusion(groupId, member, false);
    await refresh(groupId);
    return true;
  }

  async function updateChatMemberBannedRights({
    chat, user, bannedRights, untilDate,
  }: {
    chat: ApiChat;
    user: ApiUser;
    bannedRights: Record<string, unknown>;
    untilDate?: number;
  }) {
    const connection = deps.getConnection();
    const store = deps.getStore();
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;

    if (bannedRights.viewMessages) {
      const raw = await connection.request(TOPIC_GROUP_BAN, JSON.stringify({
        token: deps.getToken(), group_id: groupId, member,
      }));
      if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
      registerExclusion(groupId, member, true);
    } else if (bannedRights.sendMessages) {
      const raw = await connection.request(TOPIC_GROUP_MUTE, JSON.stringify({
        token: deps.getToken(), group_id: groupId, member, until: untilDate || 0,
      }));
      if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    } else {
      const raw = await connection.request(TOPIC_GROUP_UNBAN, JSON.stringify({
        token: deps.getToken(), group_id: groupId, member,
      }));
      if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    }
    await refresh(groupId);
    return true;
  }

  // tt зовёт при «создать ссылку»: у Parvane одна постоянная ссылка на группу
  async function exportChatInvite({ peer }: { peer: ApiChat }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!groupId) return undefined;
    const record = await ensureInviteRecord(groupId, await getSelfRole(groupId));
    return record ? buildExportedInvite(record) : undefined;
  }

  // Экран «Пригласительные ссылки»: одна постоянная ссылка, отозванных нет
  // (сервер не умеет отзыв). undefined оставлял экран в вечном «Loading»
  async function fetchExportedChatInvites({ peer, isRevoked }: {
    peer: ApiChat;
    admin?: unknown;
    isRevoked?: boolean;
    limit?: number;
  }) {
    if (isRevoked) return { invites: [] };
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!groupId) return { invites: [] };
    const selfRole = await getSelfRole(groupId);
    const record = await ensureInviteRecord(groupId, selfRole);
    // Молчаливый отказ не допускается (FR-013): владелец/админ, открывший
    // экран, обязан увидеть либо ссылку, либо ошибку
    if (!record && isInviteManager(selfRole)) reportInviteError('ссылка не получена', 'linkFailed');
    return { invites: record ? [buildExportedInvite(record)] : [] };
  }

  function reportInviteError(error?: string, code?: string) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('parvane-invite-error', {
      detail: { code: code || mapJoinError(error) },
    }));
  }

  // Формат ответа — как у апстрим-экшена acceptChatInvite: { type: 'ok', chat }.
  // Отказ (бан, недействительная ссылка, сеть) — событие для тоста, иначе
  // вступление молча ничего не делало
  async function importChatInvite({ hash }: { hash: string }) {
    const connection = deps.getConnection();
    if (!connection) {
      reportInviteError();
      return undefined;
    }
    try {
      const raw = await connection.request(
        TOPIC_GROUP_JOIN,
        JSON.stringify({ token: deps.getToken(), invite: hash }),
      );
      const response = JSON.parse(raw) as { ok: boolean; group_id?: string; name?: string; error?: string };
      if (!response.ok || !response.group_id) {
        reportInviteError(response.error);
        return undefined;
      }
      const info = await refresh(response.group_id);
      if (!info) {
        reportInviteError();
        return undefined;
      }
      const groupChat = deps.getStore().buildApiChatForGroup(info);
      deps.sendUpdate({ '@type': 'updateChat', id: groupChat.id, chat: groupChat });
      return { type: 'ok' as const, chat: groupChat };
    } catch (error) {
      // Лимит запросов приходит именно сюда: gateway отклоняет промис, а не
      // кладёт причину в тело ответа. Без передачи текста отказ обобщался до
      // `failed`, и ветка `rateLimited` была недостижима
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`вступление по ссылке не удалось: ${message}`);
      reportInviteError(message);
      return undefined;
    }
  }

  function reset() {
    inviteLinkByGroupId.clear();
  }

  return {
    reset,
    addChatMembers,
    createChannel,
    createGroupChat,
    deleteChatMember,
    deleteGroup,
    exportChatInvite,
    fetchExportedChatInvites,
    fetchFullChat,
    fetchMembers,
    importChatInvite,
    leaveGroup,
    migrateChat,
    refresh,
    refreshMemberships,
    register,
    registerExclusion,
    updateChatAdmin,
    updateChatMemberBannedRights,
    updateChatTitle,
  };
}
