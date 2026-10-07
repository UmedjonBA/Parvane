import { describe, expect, it } from 'vitest';

import { E2eSendError, getActiveGroupMemberAddresses } from './e2eSendPolicy';

describe('E2E send policy', () => {
  it('send errors carry the shared prefix', () => {
    expect(new E2eSendError('No peer.').message).toBe('End-to-end encryption failed. Message was not sent. No peer.');
  });

  it('never counts banned membership records as recipients', () => {
    expect(getActiveGroupMemberAddresses([
      { address: 'alice@local', role: 'owner' },
      { address: 'bob@local', role: 'member' },
      { address: 'mallory@local', role: 'banned' },
      { address: '', role: 'member' },
    ])).toEqual(['alice@local', 'bob@local']);
  });
});
