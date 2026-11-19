import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  isPinComplete, PIN_MAX_ATTEMPTS, readPinAttemptsLeft, registerPinAttempt, resetPinAttempts,
} from './pinAttempts';

const USER = 'pin-vera@local';
const KEY = `parvane:pin-fails:${USER}`;

const localValues = new Map<string, string>();
const testLocalStorage = {
  getItem: (key: string) => localValues.get(key),
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

describe('счётчик неверных вводов PIN', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', testLocalStorage);
    localValues.clear();
    resetPinAttempts(USER);
    resetPinAttempts('pin-other@local');
  });

  it('PIN — ровно четыре цифры', () => {
    expect(isPinComplete('1234')).toBe(true);
    expect(isPinComplete('123')).toBe(false);
    expect(isPinComplete('12345')).toBe(false);
    expect(isPinComplete('12a4')).toBe(false);
  });

  it('пять попыток, каждая уменьшает остаток, шестой нет', () => {
    expect(readPinAttemptsLeft(USER)).toBe(PIN_MAX_ATTEMPTS);
    expect([1, 2, 3, 4, 5].map(() => registerPinAttempt(USER))).toEqual([4, 3, 2, 1, 0]);
    expect(registerPinAttempt(USER)).toBe(0);
    expect(readPinAttemptsLeft(USER)).toBe(0);
  });

  it('счётчик лежит в localStorage и переживает перезагрузку страницы', async () => {
    registerPinAttempt(USER);
    registerPinAttempt(USER);
    expect(localStorage.getItem(KEY)).toBe('2');
    // «Перезагрузка»: модуль загружен заново, память вкладки пуста — остаётся только записанное
    vi.resetModules();
    const reloaded = await import('./pinAttempts');
    expect(reloaded.readPinAttemptsLeft(USER)).toBe(3);
    expect(reloaded.registerPinAttempt(USER)).toBe(2);
  });

  it('без localStorage счётчик живёт в памяти вкладки', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(registerPinAttempt(USER)).toBe(4);
    expect(readPinAttemptsLeft(USER)).toBe(4);
  });

  it('верный ввод сбрасывает счётчик', () => {
    registerPinAttempt(USER);
    registerPinAttempt(USER);
    resetPinAttempts(USER);
    expect(readPinAttemptsLeft(USER)).toBe(PIN_MAX_ATTEMPTS);
    expect(localStorage.getItem(KEY)).toBeUndefined();
  });

  it('счётчики разных аккаунтов независимы', () => {
    registerPinAttempt(USER);
    expect(readPinAttemptsLeft('pin-other@local')).toBe(PIN_MAX_ATTEMPTS);
  });

  it('испорченная запись не даёт новых попыток', () => {
    localStorage.setItem(KEY, 'много');
    expect(readPinAttemptsLeft(USER)).toBe(0);
    localStorage.setItem(KEY, '-3');
    expect(readPinAttemptsLeft(USER)).toBe(0);
  });
});
