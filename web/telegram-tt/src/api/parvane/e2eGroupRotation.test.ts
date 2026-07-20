import { beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine } from './e2e';

const values = new Map<string, string>();
const testStorage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key: string) => values.get(key),
  key: (index: number) => Array.from(values.keys())[index],
  removeItem: (key: string) => values.delete(key),
  setItem: (key: string, value: string) => values.set(key, String(value)),
};

describe('E2E group-key rotation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testStorage);
    localStorage.clear();
  });

  it('rotates on recipient exclusion and keeps the old member out', async () => {
    const sender = await E2eEngine.create('alice@local');
    const bob = await E2eEngine.create('bob@local');
    const removed = await E2eEngine.create('mallory@local');
    const group = 'group-security-test';
    const beforeMembers = ['alice@local', 'bob@local', 'mallory@local'];

    expect(sender.syncGroupRecipients(group, beforeMembers, 'alice@local')).toBe(false);
    const oldKey = sender.getGroupSessionKey(group);
    bob.acceptGroupKey(group, sender.identityKey, oldKey.sessionKey, oldKey.epoch);
    removed.acceptGroupKey(group, sender.identityKey, oldKey.sessionKey, oldKey.epoch);
    const before = sender.groupEncrypt(group, 'before removal');
    expect(removed.groupDecrypt(group, sender.identityKey, before!)).toBe('before removal');

    vi.spyOn(Date, 'now').mockReturnValue(oldKey.epoch);
    expect(sender.syncGroupRecipients(
      group,
      ['alice@local', 'bob@local'],
      'alice@local',
    )).toBe(true);
    const freshKey = sender.getGroupSessionKey(group);
    expect(freshKey.epoch).toBeGreaterThan(oldKey.epoch);
    expect(freshKey.sessionKey).not.toBe(oldKey.sessionKey);
    expect(sender.groupEncrypt(group, 'stale send', oldKey.epoch)).toBeUndefined();

    bob.acceptGroupKey(group, sender.identityKey, freshKey.sessionKey, freshKey.epoch);
    const after = sender.groupEncrypt(group, 'after removal');
    expect(bob.groupDecrypt(group, sender.identityKey, after!)).toBe('after removal');
    expect(removed.groupDecrypt(group, sender.identityKey, after!)).toBeUndefined();
  });

  it('does not rotate when a recipient is only added', async () => {
    const sender = await E2eEngine.create('owner@local');
    const group = 'group-addition-test';
    sender.syncGroupRecipients(group, ['owner@local', 'bob@local'], 'owner@local');
    const before = sender.getGroupSessionKey(group);

    expect(sender.syncGroupRecipients(
      group,
      ['owner@local', 'bob@local', 'carol@local'],
      'owner@local',
    )).toBe(false);
    expect(sender.getGroupSessionKey(group)).toEqual(before);
  });
});
