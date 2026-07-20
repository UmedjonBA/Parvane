import { describe, expect, it, vi } from 'vitest';

import {
  deliverToEveryGroupMember,
  E2eSendError,
  getActiveGroupMemberAddresses,
  requireE2e,
  requireEncrypted,
} from './e2eSendPolicy';

describe('E2E send policy', () => {
  it('rejects a missing engine or ciphertext instead of allowing plaintext fallback', () => {
    expect(() => requireE2e(undefined)).toThrow(E2eSendError);
    expect(() => requireEncrypted(undefined, 'No prekey bundle.')).toThrow(E2eSendError);
    expect(requireE2e({ ready: true })).toEqual({ ready: true });
    expect(requireEncrypted('ciphertext', 'No ciphertext.')).toBe('ciphertext');
  });

  it('requires group-key delivery to every other unique member', async () => {
    const deliver = vi.fn(() => Promise.resolve(true));
    await deliverToEveryGroupMember(
      ['alice@local', 'bob@local', 'bob@local', 'carol@local'],
      'alice@local',
      deliver,
    );
    expect(deliver.mock.calls.map(([member]) => member)).toEqual(['bob@local', 'carol@local']);
  });

  it('fails the whole group send when one member cannot receive the key', async () => {
    const deliver = vi.fn((member: string) => Promise.resolve(member !== 'carol@local'));
    await expect(deliverToEveryGroupMember(
      ['alice@local', 'bob@local', 'carol@local'],
      'alice@local',
      deliver,
    )).rejects.toThrow('carol@local');
  });

  it('never distributes a sender key to banned membership records', () => {
    expect(getActiveGroupMemberAddresses([
      { address: 'alice@local', role: 'owner' },
      { address: 'bob@local', role: 'member' },
      { address: 'mallory@local', role: 'banned' },
      { address: '', role: 'member' },
    ])).toEqual(['alice@local', 'bob@local']);
  });
});
