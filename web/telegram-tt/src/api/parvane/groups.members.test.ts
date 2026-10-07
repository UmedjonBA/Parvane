import { describe, expect, it } from 'vitest';

import type { ApiChat } from '../types';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import type { WireGroupInfo } from './wire';

import { createGroupController } from './groups';

const CHAT = { id: '-7' } as ApiChat;
const INFO: WireGroupInfo = {
  group_id: 'g-7',
  name: 'Team',
  kind: 'group',
  created_by: 'alice@local',
  members: [
    { address: 'alice@local', role: 'owner' },
    { address: 'bob@local', role: 'admin' },
    { address: 'carol@local', role: 'member' },
    { address: 'mallory@local', role: 'banned' },
  ],
};

function setup() {
  const store = {
    self: 'alice@local',
    getAddressForId: () => INFO.group_id,
    getIdForAddress: (address: string) => `id:${address}`,
    getGroupInfo: () => INFO,
    registerGroup: () => undefined,
    buildApiUser: (address: string) => ({ id: `id:${address}` }),
    getDisplayName: (address: string) => (address === 'carol@local' ? 'Carol Smith' : address),
  } as unknown as ParvaneStore;
  const connection = {} as unknown as GatewayConnection;
  const updates: unknown[] = [];
  const controller = createGroupController({
    getConnection: () => connection,
    getStore: () => store,
    selfId: () => 'id:alice@local',
    sendUpdate: (update) => updates.push(update),
    log: () => undefined,
  });
  return { controller, updates };
}

const ids = (result?: { members: { userId: string }[] }) => result?.members.map(({ userId }) => userId);

describe('fetchMembers', () => {
  it('returns active members with roles and skips the banned', async () => {
    const { controller, updates } = setup();
    const result = await controller.fetchMembers({ chat: CHAT });
    expect(ids(result)).toEqual(['id:alice@local', 'id:bob@local', 'id:carol@local']);
    expect(result?.members[0]).toMatchObject({ isOwner: true });
    expect(result?.members[1]).toMatchObject({ isAdmin: true });
    expect(updates.length).toBeGreaterThan(0);
  });

  it('filters kicked, admins and search, and applies offset', async () => {
    const { controller } = setup();
    expect(ids(await controller.fetchMembers({ chat: CHAT, memberFilter: 'kicked' }))).toEqual(['id:mallory@local']);
    expect(ids(await controller.fetchMembers({ chat: CHAT, memberFilter: 'admin' })))
      .toEqual(['id:alice@local', 'id:bob@local']);
    expect(ids(await controller.fetchMembers({ chat: CHAT, memberFilter: 'search', query: 'smith' })))
      .toEqual(['id:carol@local']);
    expect(ids(await controller.fetchMembers({ chat: CHAT, memberFilter: 'search', query: 'BOB' })))
      .toEqual(['id:bob@local']);
    expect(ids(await controller.fetchMembers({ chat: CHAT, offset: 2 }))).toEqual(['id:carol@local']);
  });
});
