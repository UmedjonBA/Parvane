import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  authStorageKeys,
  clearLoginStorage,
  consumeLegacyCredentials,
  parseLoginCredentials,
  readLoginAddress,
  saveLoginAddress,
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
