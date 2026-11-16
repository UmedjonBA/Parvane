import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  authStorageKeys,
  clearLoginStorage,
  consumeLegacyCredentials,
  isSessionExpired,
  isTokenDueForRenewal,
  parseLoginCredentials,
  readLoginAddress,
  readSessionActivity,
  readTokenClaims,
  saveLoginAddress,
  SESSION_IDLE_LIMIT_MS,
  touchSessionActivity,
} from './authStorage';

const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

describe('Parvane login storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
  });

  it('migrates a legacy password into memory and immediately deletes it', () => {
    localStorage.setItem(authStorageKeys.legacyCredentials, 'alice@local:top-secret');

    expect(consumeLegacyCredentials()).toEqual({ user: 'alice@local', password: 'top-secret' });
    expect(localStorage.getItem(authStorageKeys.legacyCredentials)).toBeFalsy();
    expect(JSON.stringify(localStorage)).not.toContain('top-secret');
  });

  it('persists only the login address', () => {
    saveLoginAddress('alice@local');

    expect(readLoginAddress()).toBe('alice@local');
    expect(localStorage.getItem(authStorageKeys.loginAddress)).toBe('alice@local');
    clearLoginStorage();
    expect(readLoginAddress()).toBeUndefined();
  });

  it('rejects malformed credential links', () => {
    expect(parseLoginCredentials('alice@local')).toBeUndefined();
    expect(parseLoginCredentials('alice@local:')).toBeUndefined();
    expect(parseLoginCredentials('alice@local:pass:with:colons')).toEqual({
      user: 'alice@local', password: 'pass:with:colons',
    });
  });
});

describe('Срок сессии «оставаться в системе»', () => {
  it('без отметки активности сессия свежая, после долгой тишины — просрочена', () => {
    localStorage.removeItem('parvane:last-active');
    expect(isSessionExpired()).toBe(false);
    const now = 1_800_000_000_000;
    touchSessionActivity(now);
    expect(readSessionActivity()).toBe(now);
    expect(isSessionExpired(now + SESSION_IDLE_LIMIT_MS - 1)).toBe(false);
    expect(isSessionExpired(now + SESSION_IDLE_LIMIT_MS + 1)).toBe(true);
    clearLoginStorage();
    expect(readSessionActivity()).toBeUndefined();
  });
});

describe('Продление токена сессии', () => {
  const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_')}.s`;

  it('читает срок и устройство токена, мусор не роняет', () => {
    expect(readTokenClaims(jwt({ iat: 100, exp: 200, dev: 'dev-1' }))).toEqual({ iat: 100, exp: 200, dev: 'dev-1' });
    expect(readTokenClaims(jwt({ exp: 'x', dev: '' }))).toEqual({ iat: undefined, exp: undefined, dev: undefined });
    expect(readTokenClaims('не токен')).toBeUndefined();
  });

  it('продлевать пора с половины срока и после его конца', () => {
    const token = jwt({ iat: 1000, exp: 3000, dev: 'dev-1' });
    expect(isTokenDueForRenewal(token, 1999_000)).toBe(false);
    expect(isTokenDueForRenewal(token, 2000_000)).toBe(true);
    expect(isTokenDueForRenewal(token, 9000_000)).toBe(true);
    expect(isTokenDueForRenewal('не токен', 9000_000)).toBe(false);
  });

  it('сутки без активности сессию больше не гасят', () => {
    const now = 1_800_000_000_000;
    touchSessionActivity(now);
    expect(isSessionExpired(now + 3 * 24 * 60 * 60 * 1000)).toBe(false);
    clearLoginStorage();
  });
});
