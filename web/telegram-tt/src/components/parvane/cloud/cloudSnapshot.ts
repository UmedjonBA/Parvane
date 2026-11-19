import type { CloudDriveState } from '../../../api/parvane/cloudDrive';

import { callApi } from '../../../api/gramjs';
import { SecureE2eStorage } from '../../../api/parvane/secureStorage';

// Снимок дерева облака для запуска без сети (spec 041 F1): показывается, пока движок не поднялся (без сети он
// не поднимается вовсе) — по нему «Заметки» открывают тексты из своего кэша, «Файлы» показывают список. Только
// показ: правки ждут подключения. Лежит в шифрованном хранилище устройства, как снимок «Плана»
const CLOUD_VIEW_RECORD = 'cloud-view';
const SAVE_DELAY_MS = 2000;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

let savedJson: string | undefined;
let saveTimer: number | undefined;

/** Запоминает сведённое дерево; запись — с задержкой, одинаковое дважды не пишется. */
export function rememberCloudView(data: CloudDriveState) {
  const json = JSON.stringify(data);
  if (json === savedJson) return;
  savedJson = json;
  // Аккаунт фиксируем сейчас: к срабатыванию таймера активным может стать другой
  const storage = openStorage();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void storage.then((opened) => opened?.saveRecord(CLOUD_VIEW_RECORD, json)).catch(() => undefined);
  }, SAVE_DELAY_MS);
}

export async function loadCloudView() {
  const storage = await openStorage();
  const json = await storage?.loadRecord<string>(CLOUD_VIEW_RECORD).catch(() => undefined);
  if (!json) return undefined;
  try {
    return JSON.parse(json) as CloudDriveState;
  } catch {
    return undefined;
  }
}

async function openStorage() {
  const info = await callParvane('fetchParvaneDiagStoreInfo', {}).catch(() => undefined) as
    { self?: string } | undefined;
  if (!info?.self) return undefined;
  return SecureE2eStorage.open(info.self).catch(() => undefined);
}
