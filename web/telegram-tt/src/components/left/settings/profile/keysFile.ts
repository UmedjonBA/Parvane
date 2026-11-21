import { callApi } from '../../../../api/gramjs';
import { markKeysBackupSaved } from './profileStatus';

// Файл копии ключей (доски `RpProfileB`, `DkSettingsB`): ключи и состояние устройства v2 под паролем
// (`parvaneExportE2eKeys`). Пароль копии на сервер не уходит — поэтому сравнить его с паролем аккаунта нельзя, правило
// «не совпадает с паролем аккаунта» остаётся подсказкой

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const FILE_NAME = 'parvane-e2e-keys.json';

export const KEYS_FILE_PASSWORD_MIN = 8;

/** Сохранить файл копии в загрузки браузера; `false` — устройство не готово отдать ключи. */
export async function saveKeysFile(user: string | undefined, password: string) {
  const result = await callParvane('parvaneExportE2eKeys', { password }) as { payload: string } | undefined;
  if (!result) return false;
  const blob = new Blob([result.payload], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = FILE_NAME;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  markKeysBackupSaved(user, await fetchKeysMark());
  return true;
}

/** Восстановить ключи этого устройства из файла копии; `false` — неверный пароль или чужой файл. */
export async function restoreKeysFile(file: File, password: string) {
  const payload = await file.text();
  return Boolean(await callParvane('parvaneImportE2eKeys', { payload, password }));
}

export function fetchKeysMark() {
  return callParvane('parvaneKeysMark') as Promise<string | undefined>;
}
