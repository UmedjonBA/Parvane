import { describe, expect, it, vi } from 'vitest';

import type { ApiChat } from '../types';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import type { WireGroupInfo } from './wire';

import { createGroupController, mapJoinError } from './groups';
import {
  TOPIC_GROUP_DELETE, TOPIC_GROUP_INFO, TOPIC_GROUP_INVITE_CREATE, TOPIC_GROUP_JOIN,
} from './wire';

const SELF = 'alice@local';
const GROUP = 'g-1';
const CHAT = { id: '-100' } as ApiChat;

function makeInfo(role: string): WireGroupInfo {
  return {
    group_id: GROUP,
    name: 'Team',
    kind: 'group',
    created_by: SELF,
    members: [{ address: SELF, role }, { address: 'bob@local', role: 'member' }],
  };
}

function makeStore(info: WireGroupInfo) {
  return {
    self: SELF,
    getAddressForId: (id: string) => (id === CHAT.id ? GROUP : undefined),
    getIdForAddress: () => CHAT.id,
    getGroupInfo: () => info,
    registerGroup: () => undefined,
    unregisterGroup: () => undefined,
    isGroupAddress: () => true,
    buildApiChatForGroup: () => CHAT,
    buildApiUser: (address: string) => ({ id: address }),
  } as unknown as ParvaneStore;
}

// Промис возвращается как есть — им имитируются и отказ сети, и ещё не
// завершённый запрос (тогда он должен разрешиться уже готовой JSON-строкой)
type Handler = (payload: Record<string, unknown>) => Record<string, unknown> | Promise<unknown>;

function setup({
  role = 'owner',
  storage = new Map<string, { link: string; date: number }>(),
  handlers = {},
} = {}) {
  const info = makeInfo(role);
  let counter = 0;
  const calls: string[] = [];
  const defaults: Record<string, Handler> = {
    [TOPIC_GROUP_INVITE_CREATE]: () => ({ ok: true, invite: `${'a'.repeat(31)}${counter++}` }),
    [TOPIC_GROUP_INFO]: () => ({ groups: [info] }),
  };
  const connection = {
    request: vi.fn((subject: string, payload: string) => {
      calls.push(subject);
      const handler = handlers[subject] || defaults[subject];
      const result = handler(JSON.parse(payload));
      if (result instanceof Promise) return result;
      return Promise.resolve(JSON.stringify(result));
    }),
  } as unknown as GatewayConnection;
  const controller = createGroupController({
    getConnection: () => connection,
    getE2e: () => undefined,
    getStore: () => makeStore(info),
    getToken: () => 'jwt',
    selfId: () => 'self-id',
    sendUpdate: () => undefined,
    onGroupRegistered: () => undefined,
    log: () => undefined,
    loadInviteLink: (groupId) => storage.get(groupId),
    saveInviteLink: (groupId, record) => { storage.set(groupId, record); },
    forgetInviteLink: (groupId) => { storage.delete(groupId); },
  });
  return {
    controller, calls, storage,
  };
}

describe('mapJoinError', () => {
  it('maps exact shard errors to UI codes', () => {
    expect(mapJoinError('ссылка недействительна')).toBe('invalid');
    expect(mapJoinError('вы забанены в этой группе')).toBe('banned');
    expect(mapJoinError('неверный или просроченный JWT')).toBe('failed');
    expect(mapJoinError(undefined)).toBe('failed');
  });
});

describe('invite links', () => {
  it('reuses the persisted link across controller instances instead of minting a new token', async () => {
    const storage = new Map<string, { link: string; date: number }>();
    const first = setup({ storage });
    const second = setup({ storage });

    const a = await first.controller.fetchExportedChatInvites({ peer: CHAT });
    const b = await second.controller.fetchExportedChatInvites({ peer: CHAT });

    expect(a.invites).toHaveLength(1);
    expect(a.invites[0]).toMatchObject({ isPermanent: true, adminId: 'self-id' });
    // Ссылка — в той же форме, что понимает адресная строка (`#+<токен>`),
    // иначе вставка адреса в браузер никуда не ведёт (FR-012)
    expect(a.invites[0].link).toMatch(/^https?:\/\/[^#]+#\+[0-9a-f]{32}$/);
    expect(b.invites[0].link).toBe(a.invites[0].link);
    const creates = [...first.calls, ...second.calls].filter((subject) => subject === TOPIC_GROUP_INVITE_CREATE);
    expect(creates).toHaveLength(1);
  });

  // SC-002: сколько бы путей ни попросили ссылку одновременно (первое открытие
  // группы дёргает и fetchFullChat, и экран ссылок), на сервере обязана
  // появиться ровно одна. Последовательный случай выше этого не ловит: там
  // второй вызов уже читает сохранённую запись
  it('collapses concurrent requests into a single invite.create', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let minted = 0;
    const { controller, calls } = setup({
      handlers: {
        [TOPIC_GROUP_INVITE_CREATE]: () => {
          minted += 1;
          return gate.then(() => JSON.stringify({ ok: true, invite: 'b'.repeat(32) }));
        },
      },
    });

    const both = Promise.all([
      controller.fetchFullChat(CHAT),
      controller.fetchExportedChatInvites({ peer: CHAT }),
    ]);
    release!();
    const [, invites] = await both;

    expect(minted).toBe(1);
    expect(calls.filter((subject) => subject === TOPIC_GROUP_INVITE_CREATE)).toHaveLength(1);
    expect(invites.invites[0].link).toMatch(/#\+b{32}$/);
  });

  it('returns no revoked links and nothing for a regular member', async () => {
    const owner = setup();
    expect(await owner.controller.fetchExportedChatInvites({ peer: CHAT, isRevoked: true })).toEqual({ invites: [] });

    const member = setup({ role: 'member' });
    expect(await member.controller.fetchExportedChatInvites({ peer: CHAT })).toEqual({ invites: [] });
    expect(member.calls).not.toContain(TOPIC_GROUP_INVITE_CREATE);
  });

  it('does not throw when the gateway rejects the request', async () => {
    const { controller } = setup({
      handlers: { [TOPIC_GROUP_INVITE_CREATE]: () => Promise.reject(new Error('rate_limited')) },
    });
    expect(await controller.fetchExportedChatInvites({ peer: CHAT })).toEqual({ invites: [] });
  });

  it('forgets the persisted link when the group is deleted', async () => {
    const { controller, storage } = setup({
      handlers: { [TOPIC_GROUP_DELETE]: () => ({ ok: true }) },
    });
    await controller.fetchExportedChatInvites({ peer: CHAT });
    expect(storage.has(GROUP)).toBe(true);
    await controller.deleteGroup(CHAT.id);
    expect(storage.has(GROUP)).toBe(false);
  });

  it('reports join errors through a window event', async () => {
    const listener = vi.fn();
    window.addEventListener('parvane-invite-error', listener);
    const { controller } = setup({
      handlers: { [TOPIC_GROUP_JOIN]: () => ({ ok: false, error: 'вы забанены в этой группе' }) },
    });
    expect(await controller.importChatInvite({ hash: 'x'.repeat(32) })).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ code: 'banned' });
    window.removeEventListener('parvane-invite-error', listener);
  });
});
