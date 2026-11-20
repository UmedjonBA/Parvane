import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { CloudNode } from './cloudModel';

import { callApi } from '../../../api/gramjs';
import { refreshCloud, showCloudNotice } from './cloudStore';

// Parvane (spec 041, CLOUD-3): действия экрана с историей версий и доступом к файлу копией.

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

/** Текст версии (`node` — узел с её содержимым, см. `pickCloudVersion`); не прочитан — `undefined`. */
export async function readCloudVersionText(container: string, node: CloudNode) {
  const got = await callParvane('parvaneCloudReadText', { container, node: node.id, blob: node.blob })
    .catch(() => undefined) as { text: string } | undefined;
  return got?.text;
}

/** Сделать прежнюю версию текущей. */
export async function restoreCloudVersion(container: string, node: string, fileId: string) {
  const result = await callParvane('parvaneCloudRestoreVersion', { container, node, fileId })
    .catch(() => undefined) as CloudResult | undefined;
  showCloudNotice(result?.ok ? 'restored' : result?.error || 'rejected');
  await refreshCloud();
  return Boolean(result?.ok);
}

/** Доступ к файлу копией: собеседник (чат `chatId`) получает копию в «Доступные мне». */
export async function sendCloudFileCopy(container: string, node: string, chatId: string) {
  const result = await callParvane('parvaneCloudSendToChat', {
    container, nodes: [node], chatId, isCopyToFiles: true,
  }).catch(() => undefined) as CloudResult | undefined;
  showCloudNotice(result?.ok ? 'copySent' : result?.error || 'rejected');
  return Boolean(result?.ok);
}
