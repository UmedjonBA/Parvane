import Olm from '@matrix-org/olm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine } from './e2e';

const TEST_USERS = [
  'alice@local', 'bob@local', 'mallory@local', 'owner@local',
  'legacy-bootstrap@local', 'legacy@local',
];
const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

describe('E2E group-key rotation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
    await Promise.all(TEST_USERS.map((user) => E2eEngine.clear(user)));
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
    const before = await sender.groupEncrypt(group, 'before removal');
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
    await expect(sender.groupEncrypt(group, 'stale send', oldKey.epoch)).resolves.toBeUndefined();

    bob.acceptGroupKey(group, sender.identityKey, freshKey.sessionKey, freshKey.epoch);
    const after = await sender.groupEncrypt(group, 'after removal');
    expect(bob.groupDecrypt(group, sender.identityKey, after!)).toBe('after removal');
    expect(removed.groupDecrypt(group, sender.identityKey, after!)).toBeUndefined();
    await Promise.all([sender, bob, removed].map((engine) => engine.flushStorage()));
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
    await sender.flushStorage();
  });

  it('restores encrypted IndexedDB state without leaving E2E data in localStorage', async () => {
    const sender = await E2eEngine.create('owner@local');
    const identity = sender.identityKey;
    sender.syncGroupRecipients('persisted-group', ['owner@local', 'bob@local'], 'owner@local');
    const groupKey = sender.getGroupSessionKey('persisted-group');
    await sender.flushStorage();

    expect(Object.keys(localStorage).some((key) => key.startsWith('parvane:e2e:'))).toBe(false);
    const restored = await E2eEngine.create('owner@local');
    expect(restored.identityKey).toBe(identity);
    expect(restored.getGroupSessionKey('persisted-group')).toEqual(groupKey);
  });

  it('re-pickles legacy localStorage state and removes its decrypted cache', async () => {
    await E2eEngine.create('legacy-bootstrap@local'); // Инициализирует Olm WASM.
    const legacyAccount = new Olm.Account();
    legacyAccount.create();
    const identity = (JSON.parse(legacyAccount.identity_keys()) as { curve25519: string }).curve25519;
    localStorage.setItem(
      'parvane:e2e:legacy@local:account',
      legacyAccount.pickle('parvane-web-pickle'),
    );
    localStorage.setItem(
      'parvane:e2e:legacy@local:dec',
      JSON.stringify({ message: { from: 'bob@local', content: 'legacy plaintext' } }),
    );
    localStorage.setItem('parvane:e2e:legacy@local:published', '1');

    const migrated = await E2eEngine.create('legacy@local');
    await migrated.flushStorage();
    expect(migrated.identityKey).toBe(identity);
    expect(Object.keys(localStorage).filter((key) => key.startsWith('parvane:e2e:legacy@local:'))).toEqual([]);

    const restored = await E2eEngine.create('legacy@local');
    expect(restored.identityKey).toBe(identity);
    expect(restored.getCachedInner('message')).toEqual({
      from: 'bob@local', content: 'legacy plaintext',
    });
    legacyAccount.free();
  });
});
