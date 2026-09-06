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
};
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
