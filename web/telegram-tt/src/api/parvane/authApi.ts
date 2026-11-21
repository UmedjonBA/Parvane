import { callApi } from '../gramjs';

// parvane* — кастомные методы провайдера вне типизированного Methods (типы
// callApi собраны из заглушек gramjs). Здесь — типизированный фасад для
// экранов входа/регистрации
type AnyCallApi = (name: string, ...args: unknown[]) => Promise<unknown>;
const anyCallApi = callApi as unknown as AnyCallApi;

export type ParvaneServerInfo = {
  domain: string;
  emailRequired: boolean;
  confirm: 'none' | 'email' | 'telegram';
  telegramBot: string;
};
export type ParvaneAuthContext = {
  nick: string;
  email: string;
  telegramBot: string;
  telegramLink: string;
  telegramMode?: 'register' | 'login';
  // spec 041: запрос в Telegram истёк; вход с защитой можно подтвердить ключом восстановления
  isTelegramExpired?: boolean;
  canUseRecoveryKey?: boolean;
  isRecoveryWrong?: boolean;
};

export type ParvaneTelegramRenewResult = 'ok' | 'telegram' | 'bad_key' | 'failed';
export type ParvaneDeletionPending = { atMs: number; requestedAtMs?: number };
export type ParvaneRegisterPayload = { nick: string; email: string; password: string };

export function fetchParvaneServerInfo() {
  return anyCallApi('parvaneFetchServerInfo') as Promise<ParvaneServerInfo | undefined>;
}

export function fetchParvaneAuthContext() {
  return anyCallApi('parvaneFetchAuthContext') as Promise<ParvaneAuthContext | undefined>;
}

export function startParvaneRegistration() {
  return anyCallApi('parvaneStartRegistration') as Promise<void>;
}

export function registerParvane(payload: ParvaneRegisterPayload) {
  return anyCallApi('parvaneRegister', payload) as Promise<void>;
}

// Экран Telegram: проверить подтверждение сразу, не дожидаясь опроса
export function checkParvaneTelegramConfirmation() {
  return anyCallApi('parvaneCheckTelegramConfirmation') as Promise<boolean>;
}

// spec 027: аккаунт ждёт удаления — войти, отменив удаление
export function restoreParvaneAccount() {
  return anyCallApi('parvaneRestoreAccount') as Promise<void>;
}

// spec 041 (доски ZpAuthX, ZdAuthX): новая ссылка в Telegram на том же экране; вход ключом вместо Telegram
export function renewParvaneTelegramLink() {
  return anyCallApi('parvaneRenewTelegramLink') as Promise<ParvaneTelegramRenewResult>;
}

export function confirmParvaneLoginWithKey(recoveryKey: string) {
  return anyCallApi('parvaneConfirmLoginWithRecoveryKey', { recoveryKey }) as Promise<ParvaneTelegramRenewResult>;
}

// spec 041 (доска RpProfileC): даты аккаунта, ждущего удаления; «Выйти, удаление продолжится»
export function fetchParvaneDeletionPending() {
  return anyCallApi('parvaneGetDeletionPending') as Promise<ParvaneDeletionPending | undefined>;
}

export function leaveParvaneDeletionPending() {
  return anyCallApi('parvaneLeaveDeletionPending') as Promise<void>;
}
