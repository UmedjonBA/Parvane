import { describe, expect, it, vi } from 'vitest';

import type { ApiUpdate } from '../types';
import type { GatewayConnection } from './gateway';
import type { WireGroupInfo, WireGroupNotice } from './wire';

import { createGroupController } from './groups';
import { ParvaneStore } from './store';
import { TOPIC_GROUP_INFO, TOPIC_GROUP_LIST } from './wire';

// GROUP-1: уведомление об изменении группы применяется по ревизии, открытые
// экраны получают апдейты, удалённый теряет группу, неизвестный вид — догон

const SELF = 'alice@local';
const GROUP = 'g-1';

function makeInfo(version: number, name = `v${version}`): WireGroupInfo {
  return {
    group_id: GROUP,
    name,
    kind: 'group',
    created_by: SELF,
    members: [{ address: SELF, role: 'owner' }, { address: 'bob@local', role: 'member' }],
    version,
    about: `about ${version}`,
  };
}

function setup(serverInfo: WireGroupInfo = makeInfo(5)) {
  const store = new ParvaneStore();
  store.self = SELF;
  const updates: ApiUpdate[] = [];
  const calls: string[] = [];
  const connection = {
    request: vi.fn((subject: string) => {
      calls.push(subject);
      if (subject === TOPIC_GROUP_INFO || subject === TOPIC_GROUP_LIST) {
        return Promise.resolve(JSON.stringify({ groups: [serverInfo] }));
      }
      return Promise.reject(new Error(`нет обработчика ${subject}`));
    }),
  } as unknown as GatewayConnection;
  const controller = createGroupController({
    getConnection: () => connection,
    getE2e: () => undefined,
    getStore: () => store,
    getToken: () => 'jwt',
    selfId: () => 'self-id',
    sendUpdate: (update) => { updates.push(update); },
    onGroupRegistered: () => undefined,
    log: () => undefined,
  });
  return {
    controller, store, updates, calls,
  };
}

const notice = (change: string, version: number, info?: WireGroupInfo): WireGroupNotice => ({
  group_id: GROUP, version, change, info,
});

describe('applyNotice (GROUP-1)', () => {
  it('применяет вложенные сведения и обновляет чат, fullInfo и участников', async () => {
    const { controller, store, updates } = setup();
    controller.register(makeInfo(2));
    await controller.applyNotice(notice('info', 3, makeInfo(3, 'renamed')));
    expect(store.getGroupInfo(GROUP)?.name).toBe('renamed');
    expect(store.getGroupVersion(GROUP)).toBe(3);
    const types = updates.map((u) => u['@type']);
    expect(types).toContain('updateChat');
    expect(types).toContain('updateChatFullInfo');
    expect(types.filter((t) => t === 'updateUser')).toHaveLength(2);
    const full = updates.find((u) => u['@type'] === 'updateChatFullInfo') as { fullInfo: { about?: string } };
    expect(full.fullInfo.about).toBe('about 3');
  });

  it('новая для клиента группа объявляется в список чатов (updateChatJoin + главный тред)', async () => {
    const { controller, updates } = setup();
    await controller.applyNotice(notice('members', 1, makeInfo(1)));
    const types = updates.map((u) => u['@type']);
    expect(types).toContain('updateChatJoin');
    expect(types).toContain('updateThreadInfo');
    // повторный нотис по известной группе — без объявления
    updates.length = 0;
    await controller.applyNotice(notice('members', 2, makeInfo(2)));
    expect(updates.map((u) => u['@type'])).not.toContain('updateChatJoin');
  });

  it('игнорирует нотис с ревизией старее известной', async () => {
    const { controller, store, updates } = setup();
    controller.register(makeInfo(4));
    await controller.applyNotice(notice('perms', 3, makeInfo(3, 'stale')));
    expect(store.getGroupInfo(GROUP)?.name).toBe('v4');
    expect(updates).toHaveLength(0);
  });

  it('равная ревизия применяется идемпотентно', async () => {
    const { controller, store, updates } = setup();
    controller.register(makeInfo(4));
    await controller.applyNotice(notice('members', 4, makeInfo(4, 'same')));
    expect(store.getGroupInfo(GROUP)?.name).toBe('same');
    expect(updates.map((u) => u['@type'])).toContain('updateChat');
  });

  it('removed/deleted снимают группу из списка', async () => {
    const { controller, store, updates } = setup();
    controller.register(makeInfo(1));
    await controller.applyNotice(notice('removed', 2));
    expect(store.isGroupAddress(GROUP)).toBe(false);
    expect(updates.map((u) => u['@type'])).toEqual(['updateChatLeave']);
  });

  it('invites/requests — событие окна; requests ещё и перечитывает счётчик', async () => {
    const listener = vi.fn();
    window.addEventListener('parvane-group-changed', listener);
    const { controller, calls } = setup(makeInfo(6));
    controller.register(makeInfo(5));
    await controller.applyNotice(notice('invites', 5));
    expect(calls).not.toContain(TOPIC_GROUP_INFO);
    await controller.applyNotice(notice('requests', 6));
    expect(calls).toContain(TOPIC_GROUP_INFO);
    expect(listener).toHaveBeenCalledTimes(2);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ groupId: GROUP, change: 'invites' });
    window.removeEventListener('parvane-group-changed', listener);
  });

  it('неизвестный вид изменения — безопасный догон через group.info', async () => {
    const { controller, store, calls } = setup(makeInfo(9, 'fresh'));
    controller.register(makeInfo(1));
    await controller.applyNotice(notice('something-new', 9));
    expect(calls).toContain(TOPIC_GROUP_INFO);
    expect(store.getGroupInfo(GROUP)?.name).toBe('fresh');
  });

  it('нотис без сведений для info — догон через group.info', async () => {
    const { controller, store } = setup(makeInfo(7, 'server'));
    controller.register(makeInfo(1));
    await controller.applyNotice(notice('info', 7));
    expect(store.getGroupInfo(GROUP)?.name).toBe('server');
  });

  it('refreshMemberships сходится по ревизии: без изменений — без апдейтов', async () => {
    const { controller, updates } = setup(makeInfo(5));
    controller.register(makeInfo(5));
    await controller.refreshMemberships();
    expect(updates.filter((u) => u['@type'] === 'updateChat')).toHaveLength(0);
    const fresher = setup(makeInfo(6));
    fresher.controller.register(makeInfo(5));
    await fresher.controller.refreshMemberships();
    expect(fresher.updates.filter((u) => u['@type'] === 'updateChat')).toHaveLength(1);
  });
});
