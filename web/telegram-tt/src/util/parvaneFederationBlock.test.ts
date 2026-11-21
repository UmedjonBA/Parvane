import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearFederationRefusal, getBlockedDomains, getForeignDomain, noteFederationRefusal,
} from './parvaneFederationBlock';

describe('плашка отказа федерации (ZpChat)', () => {
  beforeEach(() => clearFederationRefusal('other.example'));

  it('домен — только у чужого сервера', () => {
    expect(getForeignDomain('sasha@Other.Example', 'home.example')).toBe('other.example');
    expect(getForeignDomain('aliya@home.example', 'home.example')).toBeUndefined();
    expect(getForeignDomain('v2g:0a0b', 'home.example')).toBeUndefined();
  });

  it('запоминается только выключенная переписка, снимается удачной отправкой', () => {
    noteFederationRefusal('other.example', 'ParvaneFederationUnreachable');
    expect(getBlockedDomains()['other.example']).toBeUndefined();
    noteFederationRefusal('other.example', 'ParvaneFederationDomainBlocked');
    expect(getBlockedDomains()['other.example']).toBe('ParvaneFederationDomainBlocked');
    clearFederationRefusal('other.example');
    expect(getBlockedDomains()['other.example']).toBeUndefined();
  });
});
