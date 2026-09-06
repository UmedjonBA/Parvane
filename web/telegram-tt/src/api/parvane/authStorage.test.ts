import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  authStorageKeys,
  clearLoginStorage,
  consumeLegacyCredentials,
  isSessionExpired,
  parseLoginCredentials,
  readLoginAddress,
  readSessionActivity,
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
  it('без отметки активности сессия свежая, после суток тишины — просрочена', () => {
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
