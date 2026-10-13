// Миниатюры вложений чата (perf A10): при отправке фото/видео в содержимое
// кладётся JPEG не больше 320 px по длинной стороне и не больше 16 КиБ
// (`Media.thumbnail`, content.proto) — внутри шифрования. Получатель рисует
// размытое превью сразу, `?size=m` отдаёт миниатюру без скачивания файла,
// полный файл качается по открытию. Старые сообщения без миниатюры — как раньше.

import type { ApiThumbnail } from '../types';

import { base64ToBytes, bytesToBase64 } from './v2/base64';

export const THUMB_MAX_SIDE = 320;
/** Предел схемы: `Media.thumbnail` до 16 КиБ. */
export const THUMB_MAX_BYTES = 16 * 1024;
// Источник больше 40 МБ не декодируем в кадр — память вкладки
const THUMB_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
// Качество JPEG: первое — как у «Облака», дальше ужимаем до предела схемы
const THUMB_QUALITIES = [0.8, 0.6, 0.45, 0.3];
const THUMB_MIME = 'image/jpeg';

/** Размер миниатюры, вписанной в квадрат `maxSide` с сохранением пропорций. */
export function fitThumbSize(width: number, height: number, maxSide = THUMB_MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(1, width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** data-URI миниатюры из base64 поля содержимого. */
export function thumbDataUri(thumbnailB64: string) {
  return `data:${THUMB_MIME};base64,${thumbnailB64}`;
}

/** Байты миниатюры из поля содержимого (для отдачи `?size=m`). */
export function thumbBytes(thumbnailB64: string): Uint8Array | undefined {
  try {
    const bytes = base64ToBytes(thumbnailB64);
    return bytes.length && bytes.length <= THUMB_MAX_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** `ApiThumbnail` для фото/видео из содержимого провода (undefined — миниатюры нет). */
export function thumbnailFromWire(content: {
  thumbnail?: string; width?: number; height?: number;
}): ApiThumbnail | undefined {
  if (!content.thumbnail || !thumbBytes(content.thumbnail)) return undefined;
  return { dataUri: thumbDataUri(content.thumbnail), ...fitThumbSize(content.width || 320, content.height || 240) };
}

/**
 * Кадр → JPEG-миниатюра в пределах схемы (base64). Источник — картинка либо
 * кадр видео (`previewBlobUrl` вложения). Без canvas/createImageBitmap — undefined.
 */
export async function encodeThumbnail(source: Blob): Promise<string | undefined> {
  if (!source.size || source.size > THUMB_SOURCE_MAX_BYTES) return undefined;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined;
  try {
    const bitmap = await createImageBitmap(source);
    const { width, height } = fitThumbSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return undefined;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    for (const quality of THUMB_QUALITIES) {
      const blob = await new Promise<Blob | undefined>((resolve) => {
        canvas.toBlob((b) => resolve(b || undefined), THUMB_MIME, quality);
      });
      if (!blob) return undefined;
      if (blob.size <= THUMB_MAX_BYTES) return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    return undefined;
  } catch {
    return undefined;
  }
}
