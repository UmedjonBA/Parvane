import { describe, expect, it, vi } from 'vitest';

import type { ApiChat } from '../types';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import type { WireGroupInfo, WireInviteLink } from './wire';

import { createGroupController, inviteTokenFromLink, mapJoinError } from './groups';
import {
  TOPIC_GROUP_DELETE, TOPIC_GROUP_INFO, TOPIC_GROUP_INVITE_CHECK, TOPIC_GROUP_INVITE_CREATE,
  TOPIC_GROUP_INVITE_DELETE, TOPIC_GROUP_INVITE_LIST, TOPIC_GROUP_INVITE_REVOKE, TOPIC_GROUP_JOIN,
  TOPIC_GROUP_REQUEST_DECIDE, TOPIC_GROUP_REQUEST_LIST,
} from './wire';

const SELF = 'alice@local';
const GROUP = 'g-1';
const CHAT = { id: '-100' } as ApiChat;
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

function makeInfo(role: string, selfRights?: WireGroupInfo['members'][number]['admin_rights']): WireGroupInfo {
  return {
    group_id: GROUP,
    name: 'Team',
    kind: 'group',
    created_by: SELF,
    members: [{ address: SELF, role, admin_rights: selfRights }, { address: 'bob@local', role: 'member' }],
    version: 1,
  };
}

function link(token: string, extra: Partial<WireInviteLink> = {}): WireInviteLink {
  return {
    token, created_by: SELF, created_at: 100, state: 'active', ...extra,
  };
}

function makeStore(info: WireGroupInfo) {
  return {
    self: SELF,
    getAddressForId: (id: string) => (id === CHAT.id ? GROUP : id.startsWith('u:') ? id.slice(2) : undefined),
    getIdForAddress: (address: string) => (address === GROUP ? CHAT.id : `u:${address}`),
    getGroupInfo: () => info,
    getGroupVersion: () => info.version,
    registerGroup: () => true,
    unregisterGroup: () => undefined,
    isGroupAddress: () => true,
    buildApiChatForGroup: () => CHAT,
    buildApiUser: (address: string) => ({ id: `u:${address}` }),
  } as unknown as ParvaneStore;
}

// Промис возвращается как есть — им имитируются и отказ сети, и ещё не
// завершённый запрос (тогда он должен разрешиться уже готовой JSON-строкой)
type Handler = (payload: Record<string, unknown>) => Record<string, unknown> | Promise<unknown>;

function setup({
  role = 'owner',
  selfRights = undefined as WireGroupInfo['members'][number]['admin_rights'],
  storage = new Map<string, { link: string; date: number }>(),
  handlers = {},
  links = [] as WireInviteLink[],
} = {}) {
  const info = makeInfo(role, selfRights);
  let counter = 0;
  const calls: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const defaults: Record<string, Handler> = {
    [TOPIC_GROUP_INVITE_CREATE]: (payload) => {
      const token = `${'a'.repeat(31)}${counter++}`;
      const plain = !payload.title && !payload.expires_at && !payload.max_uses && !payload.request_needed;
      const title = typeof payload.title === 'string' ? payload.title : '';
      return { ok: true, invite: token, link: link(token, { is_primary: plain, title }) };
    },
    [TOPIC_GROUP_INVITE_LIST]: (payload) => ({
      ok: true, links: links.filter((l) => Boolean(l.revoked) === Boolean(payload.revoked)),
    }),
    [TOPIC_GROUP_INFO]: () => ({ groups: [info] }),
  };
  const connection = {
    request: vi.fn((subject: string, payload: string) => {
      calls.push(subject);
      const parsed = JSON.parse(payload);
      payloads.push({ subject, ...parsed });
      const handler = handlers[subject] || defaults[subject];
      if (!handler) return Promise.reject(new Error(`нет обработчика ${subject}`));
      const result = handler(parsed);
      if (result instanceof Promise) return result;
      return Promise.resolve(JSON.stringify(result));
    }),
  } as unknown as GatewayConnection;
  const updates: string[] = [];
  const controller = createGroupController({
    getConnection: () => connection,
    getE2e: () => undefined,
    getStore: () => makeStore(info),
    getToken: () => 'jwt',
    selfId: () => 'self-id',
    sendUpdate: (update) => { updates.push(update['@type']); },
    onGroupRegistered: () => undefined,
    log: () => undefined,
    loadInviteLink: (groupId) => storage.get(groupId),
    saveInviteLink: (groupId, record) => { storage.set(groupId, record); },
    forgetInviteLink: (groupId) => { storage.delete(groupId); },
    buildAvatarPhoto: (fileId) => ({ mediaType: 'photo', id: fileId, date: 0, sizes: [] }),
  });
  return {
    controller, calls, payloads, storage, updates,
  };
}

describe('mapJoinError', () => {
  it('сперва стабильный код шарда, затем прежние тексты', () => {
    expect(mapJoinError(undefined, 'revoked')).toBe('revoked');
    expect(mapJoinError(undefined, 'expired')).toBe('expired');
    expect(mapJoinError(undefined, 'exhausted')).toBe('exhausted');
    expect(mapJoinError(undefined, 'declined')).toBe('declined');
    expect(mapJoinError(undefined, 'pending')).toBe('requested');
    expect(mapJoinError('ссылка недействительна')).toBe('invalid');
    expect(mapJoinError('вы забанены в этой группе')).toBe('banned');
    expect(mapJoinError('неверный или просроченный JWT')).toBe('failed');
    expect(mapJoinError(undefined)).toBe('failed');
    expect(inviteTokenFromLink(`https://x/#+${TOKEN_A}`)).toBe(TOKEN_A);
    expect(inviteTokenFromLink(TOKEN_A)).toBe(TOKEN_A);
  });
});

describe('invite links', () => {
  it('берёт основную ссылку из списка сервера и не создаёт новую', async () => {
    const { controller, calls, storage } = setup({
      links: [link(TOKEN_A, { is_primary: true }), link(TOKEN_B, { title: 'temp', max_uses: 3, uses: 1 })],
    });
    const result = await controller.fetchExportedChatInvites({ peer: CHAT });
    expect(result.invites).toHaveLength(2);
    expect(result.invites[0]).toMatchObject({ isPermanent: true, adminId: 'self-id' });
    expect(result.invites[0].link).toMatch(/^https?:\/\/[^#]+#\+a{32}$/);
    expect(result.invites[1]).toMatchObject({ title: 'temp', usageLimit: 3, usage: 1 });
    expect(result.invites[1].isPermanent).toBeUndefined();
    expect(calls).not.toContain(TOPIC_GROUP_INVITE_CREATE);
    // основная запомнена на устройстве как кэш
    expect(storage.get(GROUP)?.link).toMatch(/#\+a{32}$/);
  });

  it('без основной в списке создаёт её ровно один раз (SC-002), даже конкурентно', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let minted = 0;
    const { controller, calls } = setup({
      handlers: {
        [TOPIC_GROUP_INVITE_CREATE]: () => {
          minted += 1;
          return gate.then(() => JSON.stringify({
            ok: true, invite: TOKEN_B, link: link(TOKEN_B, { is_primary: true }),
          }));
        },
      },
    });
    const both = Promise.all([
      controller.fetchFullChat(CHAT),
      controller.fetchExportedChatInvites({ peer: CHAT }),
    ]);
    release!();
    const [full, invites] = await both;
    expect(minted).toBe(1);
    expect(calls.filter((subject) => subject === TOPIC_GROUP_INVITE_CREATE)).toHaveLength(1);
    expect(invites.invites[0].link).toMatch(/#\+b{32}$/);
    expect(full?.fullInfo.inviteLink).toMatch(/#\+b{32}$/);
  });

  it('отозванные — отдельным списком; участнику ничего', async () => {
    const owner = setup({ links: [link(TOKEN_A, { revoked: true, state: 'revoked' })] });
    const revoked = await owner.controller.fetchExportedChatInvites({ peer: CHAT, isRevoked: true });
    expect(revoked.invites).toHaveLength(1);
    expect(revoked.invites[0].isRevoked).toBe(true);

    const member = setup({ role: 'member' });
    expect(await member.controller.fetchExportedChatInvites({ peer: CHAT })).toEqual({ invites: [] });
    expect(member.calls).not.toContain(TOPIC_GROUP_INVITE_LIST);
    expect(member.calls).not.toContain(TOPIC_GROUP_INVITE_CREATE);
  });

  it('админ с invite_users видит ссылки, без права — нет', async () => {
    const withRight = setup({ role: 'admin', links: [link(TOKEN_A, { is_primary: true })] });
    expect((await withRight.controller.fetchExportedChatInvites({ peer: CHAT })).invites).toHaveLength(1);
    const without = setup({ role: 'admin', selfRights: { invite_users: false, pin_messages: true } });
    expect(await without.controller.fetchExportedChatInvites({ peer: CHAT })).toEqual({ invites: [] });
    expect(without.calls).not.toContain(TOPIC_GROUP_INVITE_LIST);
  });

  it('при отказе сервера отдаёт прежнюю ссылку устройства или сообщает об ошибке', async () => {
    const listener = vi.fn();
    window.addEventListener('parvane-invite-error', listener);
    const storage = new Map([[GROUP, { link: `https://x/#+${TOKEN_A}`, date: 5 }]]);
    const cached = setup({
      storage, handlers: { [TOPIC_GROUP_INVITE_LIST]: () => Promise.reject(new Error('rate_limited')) },
    });
    const result = await cached.controller.fetchExportedChatInvites({ peer: CHAT });
    expect(result.invites[0].link).toMatch(/#\+a{32}$/);
    expect(listener).not.toHaveBeenCalled();
    const bare = setup({ handlers: { [TOPIC_GROUP_INVITE_LIST]: () => Promise.reject(new Error('down')) } });
    expect(await bare.controller.fetchExportedChatInvites({ peer: CHAT })).toEqual({ invites: [] });
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ code: 'linkFailed' });
    window.removeEventListener('parvane-invite-error', listener);
  });

  it('создание ссылки с параметрами уходит на сервер как есть', async () => {
    const { controller, payloads } = setup();
    const created = await controller.exportChatInvite({
      peer: CHAT, title: 'Weekend', expireDate: 1_700_000_000.7, usageLimit: 5, isRequestNeeded: true,
    });
    const call = payloads.find((p) => p.subject === TOPIC_GROUP_INVITE_CREATE)!;
    expect(call).toMatchObject({
      group_id: GROUP, title: 'Weekend', expires_at: 1_700_000_000, max_uses: 5, request_needed: true,
    });
    expect(created).toMatchObject({ title: 'Weekend' });
    expect(created?.isPermanent).toBeUndefined();
  });

  it('отзыв — через editExportedChatInvite(isRevoked); правка параметров не поддерживается', async () => {
    const listener = vi.fn();
    window.addEventListener('parvane-invite-error', listener);
    const links = [link(TOKEN_A, { is_primary: true })];
    const { controller, payloads } = setup({
      links,
      handlers: {
        [TOPIC_GROUP_INVITE_REVOKE]: () => {
          links[0] = link(TOKEN_A, { revoked: true, state: 'revoked', revoked_at: 9 });
          return { ok: true };
        },
      },
    });
    const revoked = await controller.editExportedChatInvite({
      peer: CHAT, link: `https://x/#+${TOKEN_A}`, isRevoked: true,
    });
    expect(payloads.find((p) => p.subject === TOPIC_GROUP_INVITE_REVOKE))
      .toMatchObject({ group_id: GROUP, invite: TOKEN_A });
    expect(revoked?.newInvite.isRevoked).toBe(true);
    expect(revoked?.oldInvite.link).toMatch(/#\+a{32}$/);
    expect(await controller.editExportedChatInvite({ peer: CHAT, link: `https://x/#+${TOKEN_A}`, title: 'x' }))
      .toBeUndefined();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ code: 'editUnsupported' });
    window.removeEventListener('parvane-invite-error', listener);
  });

  it('удаление отозванных: одной и всех', async () => {
    const { controller, payloads } = setup({
      links: [link(TOKEN_A, { revoked: true, state: 'revoked' }), link(TOKEN_B, { revoked: true, state: 'revoked' })],
      handlers: { [TOPIC_GROUP_INVITE_DELETE]: () => ({ ok: true }) },
    });
    expect(await controller.deleteExportedChatInvite({ peer: CHAT, link: `https://x/#+${TOKEN_A}` })).toBe(true);
    expect(await controller.deleteRevokedExportedChatInvites({ peer: CHAT })).toBe(true);
    const deletes = payloads.filter((p) => p.subject === TOPIC_GROUP_INVITE_DELETE).map((p) => p.invite);
    expect(deletes).toEqual([TOKEN_A, TOKEN_A, TOKEN_B]);
  });

  it('forgets the persisted link when the group is deleted', async () => {
    const { controller, storage } = setup({
      links: [link(TOKEN_A, { is_primary: true })],
      handlers: { [TOPIC_GROUP_DELETE]: () => ({ ok: true }) },
    });
    await controller.fetchExportedChatInvites({ peer: CHAT });
    expect(storage.has(GROUP)).toBe(true);
    await controller.deleteGroup(CHAT.id);
    expect(storage.has(GROUP)).toBe(false);
  });
});

describe('join and preview', () => {
  it('отказы вступления — событием с кодом шарда', async () => {
    const listener = vi.fn();
    window.addEventListener('parvane-invite-error', listener);
    for (const code of ['banned', 'revoked', 'expired', 'exhausted', 'declined', 'invalid']) {
      const { controller } = setup({
        handlers: { [TOPIC_GROUP_JOIN]: () => ({ ok: false, error: `ссылка: ${code}`, error_code: code }) },
      });
      expect(await controller.importChatInvite({ hash: TOKEN_A })).toBeUndefined();
    }
    expect(listener.mock.calls.map((call) => (call[0] as CustomEvent).detail.code))
      .toEqual(['banned', 'revoked', 'expired', 'exhausted', 'declined', 'invalid']);
    window.removeEventListener('parvane-invite-error', listener);
  });

  it('ссылка «по одобрению»: заявка без чата', async () => {
    const { controller, updates } = setup({
      handlers: { [TOPIC_GROUP_JOIN]: () => ({ ok: true, group_id: GROUP, name: 'Team', pending: true }) },
    });
    expect(await controller.importChatInvite({ hash: TOKEN_A })).toEqual({ type: 'requested' });
    expect(updates).not.toContain('updateChat');
  });

  it('вступление открывает чат', async () => {
    const { controller, updates } = setup({
      handlers: { [TOPIC_GROUP_JOIN]: () => ({ ok: true, group_id: GROUP, name: 'Team' }) },
    });
    expect(await controller.importChatInvite({ hash: TOKEN_A })).toEqual({ type: 'ok', chat: CHAT });
    expect(updates).toContain('updateChat');
  });

  it('превью ссылки: имя, фото, участники, одобрение; участнику — чат; ошибка — событие', async () => {
    const listener = vi.fn();
    window.addEventListener('parvane-invite-error', listener);
    const preview = setup({
      handlers: {
        [TOPIC_GROUP_INVITE_CHECK]: () => ({
          ok: true, group_id: GROUP, name: 'Team', kind: 'group', avatar: 'f-1', about: 'о нас', members_count: 4,
          request_needed: true,
        }),
      },
    });
    const result = await preview.controller.checkChatInvite(TOKEN_A);
    expect(result?.chat).toBeUndefined();
    expect(result?.invite).toMatchObject({
      title: 'Team', about: 'о нас', participantsCount: 4, isRequestNeeded: true, photo: { id: 'f-1' },
    });
    const member = setup({
      handlers: {
        [TOPIC_GROUP_INVITE_CHECK]: () => ({ ok: true, group_id: GROUP, name: 'Team', already_member: true }),
      },
    });
    expect((await member.controller.checkChatInvite(TOKEN_A))?.chat).toEqual(CHAT);
    const bad = setup({ handlers: { [TOPIC_GROUP_INVITE_CHECK]: () => ({ ok: false, error_code: 'expired' }) } });
    expect(await bad.controller.checkChatInvite(TOKEN_A)).toBeUndefined();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ code: 'expired' });
    window.removeEventListener('parvane-invite-error', listener);
  });
});

describe('join requests', () => {
  it('заявители — из group.request.list, решение — group.request.decide', async () => {
    const { controller, payloads, updates } = setup({
      handlers: {
        [TOPIC_GROUP_REQUEST_LIST]: () => ({
          ok: true,
          requests: [
            { member: 'carol@local', invite: TOKEN_A, created_at: 7 },
            { member: 'dave@local', invite: TOKEN_B, created_at: 8 },
          ],
        }),
        [TOPIC_GROUP_REQUEST_DECIDE]: () => ({ ok: true, version: 2 }),
      },
    });
    const all = await controller.fetchChatInviteImporters({ peer: CHAT, isRequested: true });
    expect(all?.importers).toEqual([
      { userId: 'u:carol@local', date: 7, isRequested: true },
      { userId: 'u:dave@local', date: 8, isRequested: true },
    ]);
    expect(updates.filter((type) => type === 'updateUser')).toHaveLength(2);
    const byLink = await controller.fetchChatInviteImporters({
      peer: CHAT, isRequested: true, link: `https://x/#+${TOKEN_B}`,
    });
    expect(byLink?.importers.map((i) => i.userId)).toEqual(['u:dave@local']);
    // вступивших сервер не хранит — пустой список без запроса
    expect(await controller.fetchChatInviteImporters({ peer: CHAT })).toEqual({ importers: [] });

    expect(await controller.hideChatJoinRequest({
      peer: CHAT, user: { id: 'u:carol@local' } as never, isApproved: true,
    })).toBe(true);
    expect(payloads.find((p) => p.subject === TOPIC_GROUP_REQUEST_DECIDE))
      .toMatchObject({ member: 'carol@local', approve: true });
    expect(await controller.hideAllChatJoinRequests({ peer: CHAT, isApproved: false })).toBe(true);
    const decides = payloads.filter((p) => p.subject === TOPIC_GROUP_REQUEST_DECIDE);
    expect(decides.map((p) => [p.member, p.approve]))
      .toEqual([['carol@local', true], ['carol@local', false], ['dave@local', false]]);
  });
});
