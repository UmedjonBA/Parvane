import type { ApiSession } from '../../../../api/types';

/**
 * Адрес аккаунта для шапки «Профиля»: `@ник · сервер`. Сервер — узел, с которого открыто приложение:
 * web ходит в gateway того же адреса (`api/parvane/gateway.ts`).
 */
export function formatProfileAddress(username?: string, server?: string) {
  if (!username) return undefined;
  return server ? `@${username} · ${server}` : `@${username}`;
}

/** Сервер аккаунта — узел страницы приложения. */
export function getProfileServer() {
  return window.location.host || undefined;
}

/** Значок устройства в списке «Обзора»: телефон, браузер либо компьютер. */
export function getDeviceIcon(session: Pick<ApiSession, 'platform' | 'deviceModel' | 'appName'>) {
  const text = `${session.platform} ${session.deviceModel} ${session.appName}`.toLowerCase();
  if (/android|ios|iphone|phone/.test(text)) return 'phone' as const;
  if (/web|browser|chrome|firefox|safari|edge|opera/.test(text)) return 'globe' as const;
  return 'laptop' as const;
}

export const MESSAGE_TEXT_SIZE_MIN = 12;
export const MESSAGE_TEXT_SIZE_MAX = 20;

/** Размер текста сообщений в допустимых пределах. */
export function clampMessageTextSize(size: number) {
  return Math.min(MESSAGE_TEXT_SIZE_MAX, Math.max(MESSAGE_TEXT_SIZE_MIN, Math.round(size)));
}
