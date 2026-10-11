import type { CloudChatFile } from '../../../api/parvane/cloudDrive';

import { createSignal } from '../../../util/signals';

// Parvane (spec 016): мост между чатами и облаком. Меню сообщения и меню
// вложений только оставляют запрос; диалоги выбора папки и файлов живут в
// `CloudChatDialogs` (смонтирован в `Main`) и не зависят от закрытия меню.

export type CloudBridgeRequest =
  | { type: 'save'; files: CloudChatFile[] }
  | { type: 'attach'; chatId: string };

type DownloadableMedia = {
  id?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  mediaType?: string;
  date?: number;
};

const [getCloudBridgeRequest, setCloudBridgeRequest] = createSignal<CloudBridgeRequest | undefined>(undefined);

export { getCloudBridgeRequest };

const MS_IN_SECOND = 1000;
const FALLBACK_NAMES: Record<string, [string, string]> = {
  photo: ['photo', 'jpg'],
  video: ['video', 'mp4'],
  audio: ['audio', 'mp3'],
  voice: ['voice', 'ogg'],
};

/** Описатель файла сообщения для облака: id блоба, имя, тип, размер. */
export function buildCloudChatFile(media: DownloadableMedia, messageDate?: number): CloudChatFile | undefined {
  if (!media.id) return undefined;
  const [base, extension] = FALLBACK_NAMES[media.mediaType || ''] || ['file', 'bin'];
  const moment = new Date((media.date || messageDate || 0) * MS_IN_SECOND);
  const stamp = moment.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return {
    fileId: media.id,
    name: media.fileName || `${base}_${stamp}.${extension}`,
    mime: media.mimeType || (media.mediaType === 'photo' ? 'image/jpeg' : 'application/octet-stream'),
    size: media.size || 0,
  };
}

/** «Сохранить в облако»: выбрать папку для файлов сообщения. */
export function requestCloudSave(files: CloudChatFile[]) {
  if (files.length) setCloudBridgeRequest({ type: 'save', files });
}

/** «Из облака»: выбрать файлы облака для отправки в чат. */
export function requestCloudAttach(chatId: string) {
  setCloudBridgeRequest({ type: 'attach', chatId });
}

export function closeCloudBridge() {
  setCloudBridgeRequest(undefined);
}
