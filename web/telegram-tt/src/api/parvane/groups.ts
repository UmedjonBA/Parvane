import type {
  ApiChat, ApiChatAdminRights, ApiChatBannedRights, ApiChatInviteImporter, ApiChatInviteInfo, ApiChatMember,
  ApiExportedInvite, ApiMessage, ApiPhoto, ApiUpdate, ApiUser,
} from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import type { createV2Controller, V2InviteRecord } from './v2/controller';
import type {
  WireDefaultPermissions, WireGroupInfo, WireGroupMember, WireGroupNotice, WireInviteCheck, WireInviteLink,
  WireJoinRequest, WireMessageContent,
} from './wire';
import { MAIN_THREAD_ID } from '../types';

import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import {
  fromBannedRights, normalizePermissions, toAdminRights, toWireAdminRights,
} from './store';
import {
  TOPIC_GROUP_ADD_MEMBER,
  TOPIC_GROUP_BAN,
  TOPIC_GROUP_CREATE,
  TOPIC_GROUP_DELETE,
  TOPIC_GROUP_INFO,
  TOPIC_GROUP_INVITE_CHECK,
  TOPIC_GROUP_INVITE_CREATE,
  TOPIC_GROUP_INVITE_DELETE,
  TOPIC_GROUP_INVITE_LIST,
  TOPIC_GROUP_INVITE_REVOKE,
  TOPIC_GROUP_JOIN,
  TOPIC_GROUP_LIST,
  TOPIC_GROUP_MUTE,
  TOPIC_GROUP_REMOVE_MEMBER,
  TOPIC_GROUP_RENAME,
  TOPIC_GROUP_REQUEST_DECIDE,
  TOPIC_GROUP_REQUEST_LIST,
  TOPIC_GROUP_SETADMIN,
  TOPIC_GROUP_SETINFO,
  TOPIC_GROUP_SETPERMS,
  TOPIC_GROUP_UNBAN,
} from './wire';

export type InviteLinkRecord = { link: string; date: number };

export type InviteErrorCode =
  | 'invalid' | 'banned' | 'revoked' | 'expired' | 'exhausted' | 'declined' | 'requested'
  | 'rateLimited' | 'failed';

// Причина отказа вступления: сперва стабильный `error_code` шарда (spec 003),
// затем — точные тексты прежнего контракта (старые шарды)
export function mapJoinError(error?: string, code?: string): InviteErrorCode {
  switch (code) {
    case 'invalid':
    case 'banned':
    case 'revoked':
    case 'expired':
    case 'exhausted':
    case 'declined':
      return code;
    case 'pending':
      return 'requested';
    default:
      break;
  }
  if (error === 'ссылка недействительна') return 'invalid';
  if (error === 'вы забанены в этой группе') return 'banned';
  // Шард может отказать по лимиту запросов — у этого отказа свой понятный текст
  if (error?.includes('rate_limited')) return 'rateLimited';
  return 'failed';
}

function isInviteManager(member?: WireGroupMember) {
  if (!member) return false;
  if (member.role === 'owner') return true;
  return member.role === 'admin' && toAdminRights(member.admin_rights).inviteUsers === true;
}

// Ссылка-приглашение в форме, которую понимают и клик в сообщении, и вставка
// адреса в браузер: `<origin><path>#+<токен>` (см. util/routing.ts)
export function buildInviteLink(token: string) {
  if (typeof window === 'undefined') return `#+${token}`;
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#+${token}`;
}

export function inviteTokenFromLink(link: string) {
  return link.match(/#\+([0-9a-f]{32})/)?.[1] || link.match(/^([0-9a-f]{32})$/)?.[1];
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
    if (content.entities?.some((e) => e.type === 'MessageEntityUrl' || e.type === 'MessageEntityTextUrl')) {
      return false;
    }
  }
  return true;
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
  // Основная ссылка группы, полученная на этом устройстве: кэш на случай,
  // когда список ссылок недоступен (источник истины — group.invite.list)
  loadInviteLink?: (groupId: string) => InviteLinkRecord | undefined;
  saveInviteLink?: (groupId: string, record: InviteLinkRecord) => void;
  forgetInviteLink?: (groupId: string) => void;
  // ApiPhoto из file_id открытого объекта cloud (фото группы в превью ссылки)
  buildAvatarPhoto?: (fileId: string) => ApiPhoto;
  // Протокол v2 (spec 007): группы с подписанным журналом состояния
  getV2?: () => V2Groups | undefined;
  // Шаблон служебного сообщения из языкового пакета (`{user}` — участник)
  getUnconfirmedTemplate?: () => string | undefined;
};

type V2Groups = ReturnType<typeof createV2Controller>;

// Mute «навсегда» в журнале группы v2: until_ms = 2^53 − 1 (0 — снять mute)
const V2_MUTE_FOREVER_MS = '9007199254740991';
const MS_IN_SECOND = 1000;

type ActionResponse = { ok?: boolean; error?: string; error_code?: string; version?: number };

// Предел описания группы в символах (как GROUP_ABOUT_MAX у шарда messenger)
const GROUP_ABOUT_MAX_CHARS = 255;

export function createGroupController(deps: GroupDependencies) {
  const inviteLinkByGroupId = new Map<string, InviteLinkRecord>();
  // Незавершённые запросы создания основной ссылки — по одному на группу
  const inviteRequestByGroupId = new Map<string, Promise<InviteLinkRecord | undefined>>();
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
    // Подписка на typing-топик группы (msg.typing.<groupChatId>) — иначе
    // «печатает…» в группе никто не услышит
    deps.onGroupRegistered(store.getIdForAddress(info.group_id, 'group'));
    const e2e = deps.getE2e();
    // Ключи группы v2 — эпохи движка, не Megolm-сессия v1
    if (v2 || !e2e || !store.self) return true;
    const activeMembers = getActiveGroupMemberAddresses(info.members);
    if (e2e.syncGroupRecipients(info.group_id, activeMembers, store.self)) {
      deps.log(`состав ${info.group_id} сократился, групповой ключ ротирован`);
    }
    return true;
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
    const v2 = v2Of(groupId);
    if (v2) {
      const verified = v2.groupInfo(groupId);
      if (verified) register(verified, true);
      return verified;
    }
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
    const cachedLink = inviteLinkByGroupId.get(info.group_id) || deps.loadInviteLink?.(info.group_id);
    return {
      members,
      adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
      canViewMembers: true,
      about: info.about || undefined,
      requestsPending: info.pending_requests,
      inviteLink: cachedLink?.link,
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
        // Изменения имени/состава/ролей/прав должны сходиться на всех клиентах
        // без full reload; новые группы — попадать в список чатов. Сравнение —
        // по ревизии сервера (GROUP-1): равная — ничего не изменилось
        const previous = store.getGroupInfo(info.group_id);
        const previousVersion = store.getGroupVersion(info.group_id);
        if (!register(info)) return;
        if (!previous || previousVersion === undefined || (info.version ?? 0) > previousVersion
          || JSON.stringify(previous) !== JSON.stringify(info)) {
          pushGroupUpdates(info, !previous);
        }
      });
      // Исчезнувшие группы: удалены владельцем либо нас выгнали (группы v2
      // в v1-списке не бывают — их состав ведёт журнал)
      store.getGroupAddresses()
        .filter((address) => !listed.has(address) && !v2Of(address))
        .forEach((address) => {
          store.unregisterGroup(address);
          deps.sendUpdate({ '@type': 'updateChatLeave', id: store.getIdForAddress(address) });
        });
    } catch {
      // Следующий delta-sync повторит membership refresh.
    }
  }

  // Уведомление об изменении группы из инбокса (GROUP-1). Для info/perms/
  // members/admin сервер вкладывает итоговые сведения — применяем по ревизии;
  // invites/requests несут только факт — открытые экраны перечитывают списки;
  // removed/deleted снимают группу; неизвестный вид — безопасный догон
  async function applyNotice(notice: WireGroupNotice) {
    const store = deps.getStore();
    const chatId = store.getIdForAddress(notice.group_id, 'group');
    switch (notice.change) {
      case 'info':
      case 'perms':
      case 'members':
      case 'admin': {
        const isNew = !store.isGroupAddress(notice.group_id);
        const info = notice.info || await refresh(notice.group_id).catch(() => undefined);
        if (!info) return;
        if (notice.info && !register(notice.info)) return;
        pushGroupUpdates(info, isNew);
        // Своё удаление из состава приходит как members без нас: чат остаётся,
        // пока не придёт removed; иначе ничего
        return;
      }
      case 'invites':
      case 'requests': {
        if (notice.change === 'requests') {
          const info = await refresh(notice.group_id).catch(() => undefined);
          if (info) pushGroupUpdates(info);
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('parvane-group-changed', {
            detail: { groupId: notice.group_id, chatId, change: notice.change },
          }));
        }
        return;
      }
      case 'removed':
      case 'deleted': {
        forgetInviteLink(notice.group_id);
        store.unregisterGroup(notice.group_id);
        deps.sendUpdate({ '@type': 'updateChatLeave', id: chatId });
        return;
      }
      default: {
        deps.log(`неизвестное изменение группы ${notice.group_id}: ${notice.change} — перечитываем`);
        const info = await refresh(notice.group_id).catch(() => undefined);
        if (info) pushGroupUpdates(info);
      }
    }
  }

  async function createGroupKind(title: string, users: ApiUser[], kind: 'group' | 'channel') {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const store = deps.getStore();
    const members = users.map((user) => store.getAddressForId(user.id)).filter(Boolean);
    // Протокол v2: стек поднят и ВСЕ участники — v2-собеседники — группа с
    // подписанным журналом; иначе v1, как раньше
    const v2 = deps.getV2?.();
    if (v2?.isReady()) {
      try {
        const v2Info = await v2.createGroup(title, members, kind);
        if (v2Info) {
          register(v2Info, true);
          const v2Chat = store.buildApiChatForGroup(v2Info);
          deps.sendUpdate({ '@type': 'updateChat', id: v2Chat.id, chat: v2Chat });
          return v2Chat;
        }
      } catch (error) {
        deps.log(`группа v2 не создана: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
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
      version: 0,
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

  async function requestAction(topic: string, payload: Record<string, unknown>): Promise<ActionResponse> {
    const connection = deps.getConnection();
    if (!connection) return { ok: false, error_code: 'offline' };
    try {
      const raw = await connection.request(topic, JSON.stringify({ token: deps.getToken(), ...payload }));
      return JSON.parse(raw) as ActionResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`${topic}: ${message}`);
      return { ok: false, error: message, error_code: message.includes('rate_limited') ? 'rate_limited' : 'failed' };
    }
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
    if (v2) {
      const isDone = await v2.changeGroup(groupId, {
        set_role: {
          member: { address: member },
          role: isPromotion ? 'ROLE_ADMIN' : 'ROLE_MEMBER',
          rights: isPromotion ? rights : {},
        },
      });
      return isDone || undefined;
    }
    const response = await requestAction(TOPIC_GROUP_SETADMIN, {
      group_id: groupId, member, rights: isPromotion ? rights : undefined,
    });
    if (!response.ok) {
      deps.log(`group.setadmin отклонён: ${response.error_code || response.error}`);
      return undefined;
    }
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
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (v2) return (await v2.setGroupInfo(groupId, { name: title })) || undefined;
    const response = await requestAction(TOPIC_GROUP_RENAME, { group_id: groupId, name: title });
    if (!response.ok) return undefined;
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
  }

  // Описание и фото (group.setinfo): владелец, админ с change_info, участник
  // с change_info в правах по умолчанию
  async function setGroupInfo(
    groupId: string,
    patch: { about?: string; avatarFileId?: string; clearAvatar?: boolean },
  ) {
    const v2 = v2Of(groupId);
    if (v2) {
      const current = v2.groupInfo(groupId);
      if (!current) return false;
      // Схема v2 меряет описание байтами (1024) — предел в символах, как у
      // v1-шарда, держит клиент, чтобы поведение экрана было одним
      if (patch.about !== undefined && [...patch.about].length > GROUP_ABOUT_MAX_CHARS) {
        deps.log(`описание группы длиннее ${GROUP_ABOUT_MAX_CHARS} символов — отклонено`);
        return false;
      }
      return v2.setGroupInfo(groupId, {
        about: patch.about,
        avatarFileId: patch.clearAvatar ? '' : (patch.avatarFileId || undefined),
      });
    }
    const response = await requestAction(TOPIC_GROUP_SETINFO, {
      group_id: groupId,
      ...(patch.about !== undefined ? { about: patch.about } : {}),
      ...(patch.avatarFileId ? { avatar_file_id: patch.avatarFileId } : {}),
      ...(patch.clearAvatar ? { clear_avatar: true } : {}),
    });
    if (!response.ok) {
      deps.log(`group.setinfo отклонён: ${response.error_code || response.error}`);
      return false;
    }
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
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
    if (v2) {
      const isDone = await v2.changeGroup(groupId, {
        set_permissions: { default_permissions: fromBannedRights(bannedRights) },
      });
      return isDone || undefined;
    }
    const response = await requestAction(TOPIC_GROUP_SETPERMS, {
      group_id: groupId, default_permissions: fromBannedRights(bannedRights),
    });
    if (!response.ok) {
      deps.log(`group.setperms отклонён: ${response.error_code || response.error}`);
      return undefined;
    }
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
  }

  async function leaveGroup(chatId: string) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chatId);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (v2) {
      if (!(await v2.changeGroup(groupId, { leave: {} }))) return undefined;
    } else {
      const response = await requestAction(TOPIC_GROUP_REMOVE_MEMBER, { group_id: groupId, member: store.self });
      if (!response.ok) return undefined;
    }
    forgetInviteLink(groupId);
    store.unregisterGroup(groupId);
    deps.sendUpdate({ '@type': 'updateChatLeave', id: chatId });
    return true;
  }

  async function deleteGroup(chatId: string) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chatId);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (v2) {
      if (!(await v2.changeGroup(groupId, { delete_group: {} }))) return undefined;
    } else {
      const response = await requestAction(TOPIC_GROUP_DELETE, { group_id: groupId });
      if (!response.ok) return undefined;
    }
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
    const v2 = v2Of(address);
    if (v2) return fetchFullChatV2(v2, address);

    const raw = await connection.request(
      TOPIC_GROUP_INFO,
      JSON.stringify({ token: deps.getToken(), group_id: address }),
    );
    const info = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups?.[0];
    if (!info) return undefined;
    register(info);

    const members = buildMembers(info.members.filter(({ role }) => role !== 'banned'));
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    const selfMember = info.members.find(({ address: member }) => member === store.self);
    const inviteLink = (await ensureInviteRecord(address, selfMember))?.link;
    return {
      fullInfo: {
        members,
        adminMembersById: Object.fromEntries(adminMembers.map((member) => [member.userId, member])),
        canViewMembers: true,
        inviteLink,
        about: info.about || undefined,
        requestsPending: info.pending_requests,
      },
      chats: [store.buildApiChatForGroup(info)],
      userStatusesById: {},
      membersCount: members.length,
    };
  }

  async function fetchFullChatV2(v2: V2Groups, address: string) {
    const info = v2.groupInfo(address);
    if (!info) return undefined;
    register(info, true);
    const store = deps.getStore();
    const members = buildMembers(info.members.filter(({ role }) => role !== 'banned'));
    const adminMembers = members.filter((member) => member.isOwner || member.isAdmin);
    const selfMember = info.members.find(({ address: member }) => member === store.self);
    const inviteLink = isInviteManager(selfMember) ? (await ensureV2Primary(v2, address))?.url : undefined;
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
    const request = (async () => {
      const links = await v2.listInvites(address);
      return links.find((link) => !link.title && !link.expiresAt && !link.usageLimit && !link.isRequestNeeded)
        || v2.createInvite(address, {});
    })().finally(() => v2PrimaryRequests.delete(address));
    v2PrimaryRequests.set(address, request);
    return request;
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
    forgetInviteLink(address);
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

  function rememberPrimary(groupId: string, link: WireInviteLink) {
    const record = { link: buildInviteLink(link.token), date: link.created_at };
    inviteLinkByGroupId.set(groupId, record);
    deps.saveInviteLink?.(groupId, record);
    return record;
  }

  function buildExportedInvite(groupId: string, link: WireInviteLink): ApiExportedInvite {
    const store = deps.getStore();
    return {
      link: buildInviteLink(link.token),
      date: link.created_at,
      title: link.title || undefined,
      isPermanent: link.is_primary ? true : undefined,
      isRevoked: link.revoked ? true : undefined,
      expireDate: link.expires_at || undefined,
      usageLimit: link.max_uses || undefined,
      usage: link.uses || undefined,
      isRequestNeeded: link.request_needed ? true : undefined,
      requested: link.pending_requests || undefined,
      adminId: link.created_by === store.self ? deps.selfId() : store.getIdForAddress(link.created_by),
    };
  }

  async function listInvites(groupId: string, revoked: boolean) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const raw = await connection.request(TOPIC_GROUP_INVITE_LIST, JSON.stringify({
      token: deps.getToken(), group_id: groupId, revoked,
    }));
    const response = JSON.parse(raw) as { ok?: boolean; links?: WireInviteLink[]; error_code?: string };
    if (!response.ok) return undefined;
    return response.links || [];
  }

  // Основная ссылка группы для владельца/админа с правом приглашать. Источник
  // истины — список сервера (is_primary); создаём новую только если у группы
  // нет ни одной активной основной. Ошибка сети не должна ронять
  // fetchFullChat — ссылки просто нет
  async function ensureInviteRecord(groupId: string, selfMember?: WireGroupMember) {
    if (!isInviteManager(selfMember)) return undefined;
    const cached = inviteLinkByGroupId.get(groupId);
    if (cached) return cached;
    // Кэш пишется только ПОСЛЕ await, поэтому без этого замка конкурентные
    // fetchFullChat и fetchExportedChatInvites при первом открытии группы
    // создавали на сервере два вечных токена (SC-002)
    const inFlight = inviteRequestByGroupId.get(groupId);
    if (inFlight) return inFlight;
    const request = resolvePrimaryRecord(groupId).finally(() => {
      inviteRequestByGroupId.delete(groupId);
    });
    inviteRequestByGroupId.set(groupId, request);
    return request;
  }

  async function resolvePrimaryRecord(groupId: string): Promise<InviteLinkRecord | undefined> {
    try {
      const links = await listInvites(groupId, false);
      if (links) {
        const primary = links.find((link) => link.is_primary && link.state === 'active');
        if (primary) return rememberPrimary(groupId, primary);
        return createInviteRecord(groupId);
      }
    } catch (error) {
      deps.log(`список ссылок ${groupId} не получен: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Список недоступен — прежняя ссылка устройства, если была
    const persisted = deps.loadInviteLink?.(groupId);
    if (persisted) inviteLinkByGroupId.set(groupId, persisted);
    return persisted;
  }

  async function createInviteRecord(groupId: string, params: {
    title?: string; expireDate?: number; usageLimit?: number; isRequestNeeded?: boolean;
  } = {}) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_GROUP_INVITE_CREATE, JSON.stringify({
        token: deps.getToken(),
        group_id: groupId,
        title: params.title || '',
        expires_at: params.expireDate ? Math.floor(params.expireDate) : 0,
        max_uses: params.usageLimit || 0,
        request_needed: Boolean(params.isRequestNeeded),
      }));
      const response = JSON.parse(raw) as { ok: boolean; invite?: string; link?: WireInviteLink };
      if (!response.ok || !response.invite) return undefined;
      const link: WireInviteLink = response.link || {
        token: response.invite, created_by: deps.getStore().self, created_at: Math.floor(Date.now() / 1000),
      };
      // Ссылку выдаём в той же форме, которую понимает адресная строка
      // (`<origin>/#+<токен>`, util/routing.ts)
      if (link.is_primary || (!params.title && !params.expireDate && !params.usageLimit && !params.isRequestNeeded
        && !inviteLinkByGroupId.has(groupId))) {
        return rememberPrimary(groupId, { ...link, is_primary: true });
      }
      return { link: buildInviteLink(link.token), date: link.created_at };
    } catch (error) {
      deps.log(`инвайт-ссылка ${groupId} не получена: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  function forgetInviteLink(groupId: string) {
    inviteLinkByGroupId.delete(groupId);
    deps.forgetInviteLink?.(groupId);
  }

  async function addChatMembers(chat: ApiChat, users: ApiUser[]) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    for (const user of users) {
      const member = store.getAddressForId(user.id);
      if (!member) continue;
      if (v2) {
        // Добавить в группу v2 можно только v2-собеседника (ключи эпохи — по v2)
        if (!(await v2.isV2Chat(member).catch(() => false))) return undefined;
        if (!(await v2.changeGroup(groupId, { add_member: { member: { address: member } } }))) return undefined;
        continue;
      }
      const response = await requestAction(TOPIC_GROUP_ADD_MEMBER, { group_id: groupId, member });
      if (!response.ok) return undefined;
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
    if (v2) {
      return (await v2.changeGroup(groupId, { remove_member: { member: { address: member } } })) || undefined;
    }
    const response = await requestAction(TOPIC_GROUP_REMOVE_MEMBER, { group_id: groupId, member });
    if (!response.ok) return undefined;
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
    const store = deps.getStore();
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const v2 = v2Of(groupId);
    if (v2) {
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

    if (bannedRights.viewMessages) {
      const response = await requestAction(TOPIC_GROUP_BAN, { group_id: groupId, member });
      if (!response.ok) return undefined;
      registerExclusion(groupId, member, true);
    } else if (bannedRights.sendMessages) {
      const response = await requestAction(TOPIC_GROUP_MUTE, { group_id: groupId, member, until: untilDate || 0 });
      if (!response.ok) return undefined;
    } else {
      const response = await requestAction(TOPIC_GROUP_UNBAN, { group_id: groupId, member });
      if (!response.ok) return undefined;
    }
    await refresh(groupId);
    return true;
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
    if (v2) {
      const record = hasParams
        ? await v2.createInvite(groupId, {
          title, expireDate, usageLimit, isRequestNeeded,
        })
        : await ensureV2Primary(v2, groupId);
      return record ? buildV2ExportedInvite(record, !hasParams) : undefined;
    }
    if (!hasParams) {
      const record = await ensureInviteRecord(groupId, selfMember);
      if (!record) return undefined;
      const token = inviteTokenFromLink(record.link) || '';
      return buildExportedInvite(groupId, {
        token, created_by: deps.getStore().self, created_at: record.date, is_primary: true, state: 'active',
      });
    }
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const raw = await connection.request(TOPIC_GROUP_INVITE_CREATE, JSON.stringify({
      token: deps.getToken(),
      group_id: groupId,
      title: title || '',
      expires_at: expireDate ? Math.floor(expireDate) : 0,
      max_uses: usageLimit || 0,
      request_needed: Boolean(isRequestNeeded),
    }));
    const response = JSON.parse(raw) as { ok: boolean; invite?: string; link?: WireInviteLink; error_code?: string };
    if (!response.ok || !response.link) {
      deps.log(`group.invite.create отклонён: ${response.error_code}`);
      return undefined;
    }
    return buildExportedInvite(groupId, response.link);
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
    if (v2) {
      // Отозванная ссылка v2 уходит из журнала — списка отозванных нет
      if (isRevoked) return { invites: [] };
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
    let links: WireInviteLink[] | undefined;
    try {
      links = await listInvites(groupId, Boolean(isRevoked));
    } catch (error) {
      deps.log(`список ссылок ${groupId} не получен: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!links) {
      if (isRevoked) return { invites: [] };
      // Молчаливый отказ не допускается (FR-013): владелец/админ, открывший
      // экран, обязан увидеть либо ссылку, либо ошибку
      const record = inviteLinkByGroupId.get(groupId) || deps.loadInviteLink?.(groupId);
      if (!record) {
        reportInviteError('ссылка не получена', 'linkFailed');
        return { invites: [] };
      }
      const token = inviteTokenFromLink(record.link) || '';
      return {
        invites: [buildExportedInvite(groupId, {
          token, created_by: deps.getStore().self, created_at: record.date, is_primary: true, state: 'active',
        })],
      };
    }
    if (!isRevoked) {
      const primary = links.find((link) => link.is_primary && link.state === 'active');
      if (primary) {
        rememberPrimary(groupId, primary);
      } else {
        const created = await ensureInviteRecord(groupId, selfMember);
        if (created) {
          const token = inviteTokenFromLink(created.link) || '';
          if (!links.some((link) => link.token === token)) {
            links.unshift({
              token, created_by: deps.getStore().self, created_at: created.date, is_primary: true, state: 'active',
            });
          }
        } else {
          reportInviteError('ссылка не получена', 'linkFailed');
        }
      }
    }
    return { invites: links.map((link) => buildExportedInvite(groupId, link)) };
  }

  // Сервер не правит параметры ссылки — экран tt зовёт это для отзыва
  // (`isRevoked: true`); остальные правки — «отзови и создай новую»
  async function editExportedChatInvite({ peer, link, isRevoked }: {
    peer: ApiChat; link: string; isRevoked?: boolean;
    expireDate?: number; usageLimit?: number; isRequestNeeded?: boolean; title?: string;
  }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    const v2 = groupId ? v2Of(groupId) : undefined;
    if (v2 && groupId) {
      if (!isRevoked) {
        reportInviteError(undefined, 'editUnsupported');
        return undefined;
      }
      const record = (await v2.listInvites(groupId)).find((item) => item.url === link);
      if (!record || !(await v2.revokeInvite(groupId, link))) return undefined;
      return { oldInvite: buildV2ExportedInvite(record), newInvite: buildV2ExportedInvite(record, false, true) };
    }
    const token = inviteTokenFromLink(link);
    if (!groupId || !token) return undefined;
    if (!isRevoked) {
      reportInviteError(undefined, 'editUnsupported');
      return undefined;
    }
    const response = await requestAction(TOPIC_GROUP_INVITE_REVOKE, { group_id: groupId, invite: token });
    if (!response.ok) return undefined;
    if (inviteTokenFromLink(inviteLinkByGroupId.get(groupId)?.link || '') === token) forgetInviteLink(groupId);
    const revoked = (await listInvites(groupId, true).catch(() => undefined))?.find((item) => item.token === token);
    const oldInvite: ApiExportedInvite = { link, date: 0, adminId: deps.selfId() };
    const newInvite = revoked ? buildExportedInvite(groupId, revoked) : { ...oldInvite, isRevoked: true as const };
    return { oldInvite, newInvite };
  }

  async function deleteExportedChatInvite({ peer, link }: { peer: ApiChat; link: string }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    // Отозванной ссылки v2 уже нет в журнале — удалять нечего
    if (groupId && v2Of(groupId)) return true;
    const token = inviteTokenFromLink(link);
    if (!groupId || !token) return undefined;
    const response = await requestAction(TOPIC_GROUP_INVITE_DELETE, { group_id: groupId, invite: token });
    return response.ok ? true : undefined;
  }

  async function deleteRevokedExportedChatInvites({ peer }: { peer: ApiChat; admin?: unknown }) {
    const groupId = deps.getStore().getAddressForId(peer.id);
    if (!groupId) return undefined;
    if (v2Of(groupId)) return true;
    const revoked = await listInvites(groupId, true).catch(() => undefined);
    if (!revoked) return undefined;
    for (const link of revoked) {
      await requestAction(TOPIC_GROUP_INVITE_DELETE, { group_id: groupId, invite: link.token });
    }
    return true;
  }

  async function listJoinRequests(groupId: string) {
    const connection = deps.getConnection();
    if (!connection) return undefined;
    const raw = await connection.request(TOPIC_GROUP_REQUEST_LIST, JSON.stringify({
      token: deps.getToken(), group_id: groupId,
    }));
    const response = JSON.parse(raw) as { ok?: boolean; requests?: WireJoinRequest[] };
    if (!response.ok) return undefined;
    return response.requests || [];
  }

  // Вступившие по ссылке сервер не хранит (только счётчик) — список пуст;
  // заявители (`isRequested`) — из group.request.list
  async function fetchChatInviteImporters({ peer, link, isRequested }: {
    peer: ApiChat; link?: string; offsetDate?: number; offsetUser?: ApiUser; limit?: number; isRequested?: boolean;
  }): Promise<{ importers: ApiChatInviteImporter[] } | undefined> {
    const store = deps.getStore();
    const groupId = store.getAddressForId(peer.id);
    if (!groupId) return undefined;
    if (!isRequested) return { importers: [] };
    const v2 = v2Of(groupId);
    if (v2) {
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
    const requests = await listJoinRequests(groupId).catch(() => undefined);
    if (!requests) return undefined;
    const token = link ? inviteTokenFromLink(link) : undefined;
    const importers = requests
      .filter((request) => !token || request.invite === token)
      .map((request) => {
        const user = store.buildApiUser(request.member);
        deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
        return { userId: user.id, date: request.created_at, isRequested: true as const };
      });
    return { importers };
  }

  async function hideChatJoinRequest(
    { peer, user, isApproved }: { peer: ApiChat; user: ApiUser; isApproved: boolean },
  ) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(peer.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    const v2 = v2Of(groupId);
    if (v2) return (await v2.decideJoinRequest(groupId, member, isApproved)) ? true : undefined;
    const response = await requestAction(TOPIC_GROUP_REQUEST_DECIDE, {
      group_id: groupId, member, approve: isApproved,
    });
    if (!response.ok) return undefined;
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
  }

  async function hideAllChatJoinRequests(
    { peer, isApproved, link }: { peer: ApiChat; isApproved: boolean; link?: string },
  ) {
    const store = deps.getStore();
    const groupId = store.getAddressForId(peer.id);
    if (!groupId) return undefined;
    const v2 = v2Of(groupId);
    if (v2) {
      const pending = await v2.listJoinRequests(groupId);
      if (!pending) return undefined;
      for (const request of pending) {
        await v2.decideJoinRequest(groupId, request.user, isApproved);
      }
      return true;
    }
    const requests = await listJoinRequests(groupId).catch(() => undefined);
    if (!requests) return undefined;
    const token = link ? inviteTokenFromLink(link) : undefined;
    for (const request of requests) {
      if (token && request.invite !== token) continue;
      await requestAction(TOPIC_GROUP_REQUEST_DECIDE, {
        group_id: groupId, member: request.member, approve: isApproved,
      });
    }
    const info = await refresh(groupId);
    if (info) pushGroupUpdates(info);
    return true;
  }

  function reportInviteError(error?: string, code?: string) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('parvane-invite-error', {
      detail: { code: code || mapJoinError(error) },
    }));
  }

  // Превью ссылки до вступления (group.invite.check): нативная модалка
  // «Join group» с именем, фото, числом участников и «Request to Join»;
  // участнику — сразу чат; недействительная — тост с причиной
  async function checkChatInvite(hash: string) {
    const v2 = deps.getV2?.();
    if (v2?.isV2InviteUrl(hash)) return checkChatInviteV2(v2, hash);
    const connection = deps.getConnection();
    if (!connection) {
      reportInviteError();
      return undefined;
    }
    try {
      const raw = await connection.request(TOPIC_GROUP_INVITE_CHECK, JSON.stringify({
        token: deps.getToken(), invite: hash,
      }));
      const response = JSON.parse(raw) as WireInviteCheck;
      if (!response.ok || !response.group_id) {
        reportInviteError(response.error, response.error_code);
        return undefined;
      }
      if (response.already_member) {
        const info = await refresh(response.group_id);
        if (info) {
          const chat = deps.getStore().buildApiChatForGroup(info);
          deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
          return { invite: buildInviteInfo(response), chat, users: [] };
        }
      }
      if (response.pending) reportInviteError(undefined, 'requested');
      return { invite: buildInviteInfo(response), users: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`проверка ссылки не удалась: ${message}`);
      reportInviteError(message);
      return undefined;
    }
  }

  // Ссылка v2 `https://<домен>/join/<link_id>#<секрет>`: превью по link_id
  // (секрет серверу не уходит); участнику — сразу чат
  async function checkChatInviteV2(v2: V2Groups, url: string) {
    const check = await v2.checkInvite(url);
    if (!check) {
      reportInviteError(undefined, 'invalid');
      return undefined;
    }
    if ('error' in check) {
      reportInviteError(undefined, check.error.status === 'error' ? check.error.code : 'failed');
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

  async function importChatInviteV2(v2: V2Groups, url: string) {
    const result = await v2.joinByInvite(url);
    if (!result) {
      reportInviteError(undefined, 'invalid');
      return undefined;
    }
    if (result.status === 'requested') return { type: 'requested' as const };
    if (result.status === 'error') {
      reportInviteError(undefined, result.code);
      return undefined;
    }
    register(result.info, true);
    pushGroupUpdates(result.info, true);
    const groupChat = deps.getStore().buildApiChatForGroup(result.info);
    return { type: 'ok' as const, chat: groupChat };
  }

  function buildInviteInfo(check: WireInviteCheck): ApiChatInviteInfo {
    return {
      title: check.name || '',
      about: check.about || undefined,
      photo: check.avatar && deps.buildAvatarPhoto ? deps.buildAvatarPhoto(check.avatar) : undefined,
      participantsCount: check.members_count,
      isRequestNeeded: check.request_needed ? true : undefined,
      isChannel: check.kind === 'channel' ? true : undefined,
      isBroadcast: check.kind === 'channel' ? true : undefined,
      color: 0,
    };
  }

  // Формат ответа — как у апстрим-экшена acceptChatInvite: { type: 'ok', chat }.
  // Отказ (бан, отозвана, истекла, исчерпана, отклонена, сеть) — событие для
  // тоста; заявка «по одобрению» — pending без чата (тост показывает tt)
  async function importChatInvite({ hash }: { hash: string }) {
    const v2 = deps.getV2?.();
    if (v2?.isV2InviteUrl(hash)) return importChatInviteV2(v2, hash);
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
      const response = JSON.parse(raw) as {
        ok: boolean; group_id?: string; name?: string; error?: string; error_code?: string; pending?: boolean;
      };
      if (!response.ok || !response.group_id) {
        reportInviteError(response.error, response.error_code);
        return undefined;
      }
      if (response.pending) {
        deps.log(`заявка на вступление в ${response.group_id} отправлена`);
        return { type: 'requested' as const };
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
    announceUnconfirmed,
    applyV2Group,
    registerCachedV2,
    removeV2Group,
    addChatMembers,
    applyNotice,
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
    refreshMemberships,
    register,
    registerExclusion,
    setGroupInfo,
    updateChatAbout,
    updateChatAdmin,
    updateChatDefaultBannedRights,
    updateChatMemberBannedRights,
    updateChatTitle,
  };
}
