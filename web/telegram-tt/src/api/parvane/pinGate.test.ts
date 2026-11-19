import { beforeEach, describe, expect, it } from 'vitest';

import { PIN_MAX_ATTEMPTS, resetPinAttempts } from '../../util/pinAttempts';
import {
  dropPinRequest, getPinRequest, requestPinUnlock, submitPin, subscribeToPinRequest,
} from './pinGate';

const USER = 'gate-vera@local';
const tryPin = (pin: string) => Promise.resolve(pin === '4821');

describe('запрос PIN хранилища', () => {
  beforeEach(() => {
    dropPinRequest();
    resetPinAttempts(USER);
  });

  it('неверный ввод тратит попытку, верный открывает и возвращает все попытки', async () => {
    let isDone = false;
    void requestPinUnlock(USER, tryPin).then((isUnlocked) => {
      isDone = isUnlocked;
    });
    expect(getPinRequest()).toEqual({ user: USER, attemptsLeft: PIN_MAX_ATTEMPTS });

    expect(await submitPin('0000')).toEqual({ isUnlocked: false, attemptsLeft: 4 });
    expect(await submitPin('1111')).toEqual({ isUnlocked: false, attemptsLeft: 3 });
    expect(isDone).toBe(false);

    expect(await submitPin('4821')).toEqual({ isUnlocked: true, attemptsLeft: PIN_MAX_ATTEMPTS });
    await Promise.resolve();
    expect(isDone).toBe(true);
    expect(getPinRequest()).toBeUndefined();
  });

  it('после пяти неверных вводов PIN больше не проверяется — даже верный', async () => {
    void requestPinUnlock(USER, tryPin);
    for (const left of [4, 3, 2, 1, 0]) {
      expect(await submitPin('0000')).toEqual({ isUnlocked: false, attemptsLeft: left });
    }
    expect(await submitPin('4821')).toEqual({ isUnlocked: false, attemptsLeft: 0 });
    expect(getPinRequest()).toEqual({ user: USER, attemptsLeft: 0 });
  });

  it('неполный ввод попытку не тратит', async () => {
    void requestPinUnlock(USER, tryPin);
    expect(await submitPin('48')).toEqual({ isUnlocked: false, attemptsLeft: PIN_MAX_ATTEMPTS });
  });

  it('выход из аккаунта снимает запрос и отпускает ожидающего', async () => {
    let calls = 0;
    const unsubscribe = subscribeToPinRequest(() => {
      calls += 1;
    });
    const pending = requestPinUnlock(USER, tryPin);
    expect(requestPinUnlock(USER, tryPin)).toBe(pending);
    dropPinRequest();
    expect(await pending).toBe(false);
    expect(getPinRequest()).toBeUndefined();
    expect(calls).toBe(2);
    unsubscribe();
  });
});
