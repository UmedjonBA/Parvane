// Parvane (spec 041, доски `PhoneProfile`, `DkSettingsB`): значения строк «Профиля» — когда сохранена копия ключей
// (отметка устройства, пишется при сохранении файла копии; данные аккаунта — стираются при выходе) и сколько места
// приложение занимает в браузере (`navigator.storage.estimate`)

const KEYS_BACKUP_PREFIX = 'parvane:keys-backup-at:';
// Набор своих устройств на момент сохранения файла (`parvaneKeysMark`): другой набор — ключи с тех пор менялись
const KEYS_MARK_PREFIX = 'parvane:keys-backup-mark:';

export function markKeysBackupSaved(user: string | undefined, keysMark?: string, at = Date.now()) {
  if (!user) return;
  try {
    localStorage.setItem(`${KEYS_BACKUP_PREFIX}${user}`, String(at));
    if (keysMark) {
      localStorage.setItem(`${KEYS_MARK_PREFIX}${user}`, keysMark);
    } else {
      localStorage.removeItem(`${KEYS_MARK_PREFIX}${user}`);
    }
  } catch {
    // Отметка просто не появится
  }
}

/** Менялись ли ключи после сохранения файла копии; `undefined` — неизвестно (нет отметки или движок не готов). */
export function getIsKeysBackupStale(user: string | undefined, currentMark: string | undefined) {
  if (!user || !currentMark) return undefined;
  try {
    const saved = localStorage.getItem(`${KEYS_MARK_PREFIX}${user}`);
    return saved ? saved !== currentMark : undefined;
  } catch {
    return undefined;
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
