import type { ApiChat, ApiUpdate, ApiUser } from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import {
  TOPIC_GROUP_ADD_MEMBER,
  TOPIC_GROUP_BAN,
  TOPIC_GROUP_CREATE,
  TOPIC_GROUP_INFO,
  TOPIC_GROUP_INVITE_CREATE,
  TOPIC_GROUP_JOIN,
  TOPIC_GROUP_LIST,
  TOPIC_GROUP_MUTE,
  TOPIC_GROUP_REMOVE_MEMBER,
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

  async function refreshMemberships() {
    const connection = deps.getConnection();
    if (!connection) return;
    try {
      const raw = await connection.request(
        TOPIC_GROUP_LIST,
        JSON.stringify({ token: deps.getToken() }),
      );
      const groups = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups || [];
      groups.forEach(register);
    } catch {
      // Следующий delta-sync повторит membership refresh.
    }
  }

  async function createGroupChat({ title, users }: { title: string; users: ApiUser[] }) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const store = deps.getStore();
    const members = users.map((user) => store.getAddressForId(user.id)).filter(Boolean);
    const raw = await connection.request(TOPIC_GROUP_CREATE, JSON.stringify({
      token: deps.getToken(), name: title, kind: 'group', members,
    }));
    const response = JSON.parse(raw) as { ok: boolean; group_id?: string; error?: string };
    if (!response.ok || !response.group_id) return undefined;

    const info: WireGroupInfo = {
      group_id: response.group_id,
      name: title,
      kind: 'group',
      created_by: store.self,
      members: [
        { address: store.self, role: 'owner' },
        ...members.map((address) => ({ address, role: 'member' })),
      ],
    };
    register(info);
    const chat = store.buildApiChatForGroup(info);
    deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
    return { chat, missingUsers: [] };
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
    return {
      fullInfo: {
        members,
        adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
        canViewMembers: true,
      },
      chats: [store.buildApiChatForGroup(info)],
      userStatusesById: {},
      membersCount: members.length,
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
    return groupChat;
  }

  return {
    addChatMembers,
    createGroupChat,
    deleteChatMember,
    exportChatInvite,
    fetchFullChat,
    importChatInvite,
    refresh,
    refreshMemberships,
    register,
    registerExclusion,
    updateChatMemberBannedRights,
  };
}
