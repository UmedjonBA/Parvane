// Parvane (spec 041, доски `PhoneProfile`, `DkSettingsB`): значения строк «Профиля» — когда сохранена копия ключей
// (отметка устройства, пишется при сохранении файла копии; данные аккаунта — стираются при выходе) и сколько места
// приложение занимает в браузере (`navigator.storage.estimate`)

const KEYS_BACKUP_PREFIX = 'parvane:keys-backup-at:';

export function markKeysBackupSaved(user: string | undefined, at = Date.now()) {
  if (!user) return;
  try {
    localStorage.setItem(`${KEYS_BACKUP_PREFIX}${user}`, String(at));
  } catch {
    // Отметка просто не появится
  }
}

/** Время сохранения файла копии ключей на этом устройстве; `undefined` — копию отсюда не сохраняли. */
export function getKeysBackupSavedAt(user: string | undefined): number | undefined {
  if (!user) return undefined;
  try {
    const value = Number(localStorage.getItem(`${KEYS_BACKUP_PREFIX}${user}`));
    return value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function formatBackupDate(at: number, langCode: string) {
  return new Intl.DateTimeFormat(langCode, { day: 'numeric', month: 'long' }).format(new Date(at));
}

/** Сколько байт занимают данные приложения в браузере; `undefined` — браузер не говорит. */
export async function fetchStorageUsage(): Promise<number | undefined> {
  try {
    const estimate = await navigator.storage?.estimate();
    return estimate?.usage;
  } catch {
    return undefined;
  }
}
