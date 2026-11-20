import type { BiometricUnlock } from './pinGate';

import {
  checkStoragePin, enrollStorageBiometric, hasStoragePin, readStorageBiometric, removeStorageBiometric,
  unlockStorageWithBiometric,
} from './secureStorage';
import { checkPrfOffered, createPrfCredential, evaluatePrf } from './storageWebAuthn';

// Вход по отпечатку в «PIN хранилища» (spec 041, доска `RpProfileB` «Открывать отпечатком»): включается только при
// заданном PIN и только там, где аутентификатор отдаёт секрет PRF — без него функция не предлагается (ключ хранилища
// открытым на диск не кладётся). PIN остаётся запасным путём; отмена на аутентификаторе попыткой PIN не считается
export type BiometricState = { isOffered: boolean; isEnabled: boolean };
export type BiometricEnableResult = 'ok' | 'bad_pin' | 'no_pin' | 'unsupported' | 'cancelled' | 'failed';

export async function getBiometricState(user: string): Promise<BiometricState> {
  const [hasPin, record, isOffered] = await Promise.all([
    hasStoragePin(user).catch(() => false),
    readStorageBiometric(user).catch(() => undefined),
    checkPrfOffered(),
  ]);
  return { isOffered: hasPin && (isOffered || Boolean(record)), isEnabled: hasPin && Boolean(record) };
}

/** PIN проверяется до обращения к аутентификатору: неверный не вызывает окно отпечатка. */
export async function enableBiometric(user: string, pin: string): Promise<BiometricEnableResult> {
  if (!await hasStoragePin(user).catch(() => false)) return 'no_pin';
  if (!await checkStoragePin(user, pin).catch(() => false)) return 'bad_pin';
  if (!await checkPrfOffered()) return 'unsupported';
  const credential = await createPrfCredential(`Parvane · ${user}`);
  if (typeof credential === 'string') return credential;
  try {
    return await enrollStorageBiometric(user, pin, credential) ? 'ok' : 'bad_pin';
  } catch {
    return 'failed';
  } finally {
    credential.prf.fill(0);
  }
}

export function disableBiometric(user: string) {
  return removeStorageBiometric(user);
}

/** Экран блокировки: открыть хранилище отпечатком. */
export async function unlockWithBiometric(user: string): Promise<BiometricUnlock> {
  const record = await readStorageBiometric(user).catch(() => undefined);
  if (!record) return 'failed';
  const prf = await evaluatePrf(record.credentialId, record.prfSalt);
  if (prf === 'cancelled') return 'cancelled';
  if (typeof prf === 'string') return 'failed';
  try {
    return await unlockStorageWithBiometric(user, prf) ? 'ok' : 'failed';
  } catch {
    return 'failed';
  } finally {
    prf.fill(0);
  }
}

export async function hasBiometricUnlock(user: string) {
  return Boolean(await readStorageBiometric(user).catch(() => undefined));
}
