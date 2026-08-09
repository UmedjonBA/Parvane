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

type GroupDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
};

export function createGroupController(deps: GroupDependencies) {
  const inviteLinkByGroupId = new Map<string, string>();

  function register(info: WireGroupInfo) {
    const store = deps.getStore();
    store.registerGroup(info);
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

    const activeMembers = info.members.filter(({ role }) => role !== 'banned');
    activeMembers.forEach((member) => {
      const user = store.buildApiUser(member.address);
      deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    });
    const members = activeMembers.map((member) => ({
      userId: store.getIdForAddress(member.address),
      isOwner: member.role === 'owner' ? true as const : undefined,
      isAdmin: member.role === 'admin' ? true as const : undefined,
    }));
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    const selfRole = info.members.find(({ address: member }) => member === store.self)?.role;
    const inviteLink = await ensureInviteLink(chat, address, selfRole);
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

  // Постоянная инвайт-ссылка группы для владельца/админа: шард создаёт новый
  // токен на каждый запрос — кэшируем на сессию, чтобы не плодить строки
  async function ensureInviteLink(chat: ApiChat, groupId: string, selfRole?: string) {
    if (selfRole !== 'owner' && selfRole !== 'admin') return undefined;
    const cached = inviteLinkByGroupId.get(groupId);
    if (cached) return cached;
    const exported = await exportChatInvite({ peer: chat });
    if (!exported) return undefined;
    inviteLinkByGroupId.set(groupId, exported.link);
    return exported.link;
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

  async function exportChatInvite({ peer }: { peer: ApiChat }) {
    const connection = deps.getConnection();
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!connection || !groupId) return undefined;
    const raw = await connection.request(TOPIC_GROUP_INVITE_CREATE, JSON.stringify({
      token: deps.getToken(), group_id: groupId,
    }));
    const response = JSON.parse(raw) as { ok: boolean; invite?: string };
    if (!response.ok || !response.invite) return undefined;
    return {
      link: `https://parvane.invite/${response.invite}`,
      date: Math.floor(Date.now() / 1000),
      isPermanent: true,
      adminId: deps.selfId(),
    };
  }

  // Формат ответа — как у апстрим-экшена acceptChatInvite: { type: 'ok', chat }
  async function importChatInvite({ hash }: { hash: string }) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const raw = await connection.request(
      TOPIC_GROUP_JOIN,
      JSON.stringify({ token: deps.getToken(), invite: hash }),
    );
    const response = JSON.parse(raw) as { ok: boolean; group_id?: string; name?: string };
    if (!response.ok || !response.group_id) return undefined;
    const info = await refresh(response.group_id);
    if (!info) return undefined;
    const groupChat = deps.getStore().buildApiChatForGroup(info);
    deps.sendUpdate({ '@type': 'updateChat', id: groupChat.id, chat: groupChat });
    return { type: 'ok' as const, chat: groupChat };
  }

  return {
    addChatMembers,
    createChannel,
    createGroupChat,
    deleteChatMember,
    deleteGroup,
    exportChatInvite,
    fetchFullChat,
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
