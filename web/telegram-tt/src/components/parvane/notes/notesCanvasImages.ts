// Parvane, раздел «Знания»: картинки карточек файлов на холсте в полном качестве. Миниатюра облака — 320 точек
// по длинной стороне; растянутая на карточку и увеличенная масштабом холста, она мутная, поэтому карточка
// показывает сам файл. Адрес расшифрованной картинки (object URL) один на файл: его делят все карточки этого
// файла, он переживает перерисовки и смену масштаба и освобождается, когда карточек с ним не осталось.

import type { CloudNode } from '../cloud/cloudModel';

import { kindOfFile } from '../cloud/cloudModel';

export type CanvasImageQuality = 'full' | 'thumb';
// Что показывает карточка: сам файл, миниатюру либо значок файла
export type CanvasImageSource = 'full' | 'thumb' | 'none';

export type CanvasImageCacheDeps = {
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  // Столько адрес живёт после ухода последней карточки: возврат на вкладку и отмена удаления не качают заново
  keepMs: number;
};

type Entry = {
  promise: Promise<string | undefined>; users: number; url?: string; timer?: unknown; isDropped?: boolean;
};

// Картинка больше этого в карточку целиком не читается — остаётся миниатюра (сам файл открывает просмотр)
export const CANVAS_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const KEEP_MS = 30000;

export function isCanvasImage(node?: Pick<CloudNode, 'mime' | 'name'>) {
  return node ? kindOfFile(node.mime, node.name) === 'photo' : false;
}

// Откуда карточка берёт картинку. Полное качество — у картинки не больше предела; слишком большая и любая
// при настройке «миниатюрами» показывают миниатюру, а без неё — значок файла
export function canvasImageSource(
  node: Pick<CloudNode, 'mime' | 'name' | 'size' | 'blob' | 'thumb'> | undefined, quality: CanvasImageQuality,
  maxBytes = CANVAS_IMAGE_MAX_BYTES,
): CanvasImageSource {
  if (!node?.blob) return 'none';
  if (quality === 'full' && isCanvasImage(node) && node.size <= maxBytes) return 'full';
  return node.thumb ? 'thumb' : 'none';
}

// Адреса картинок по ключу (версия содержимого файла) со счётчиком карточек
export function createCanvasImageCache(deps: CanvasImageCacheDeps) {
  const entries = new Map<string, Entry>();

  const drop = (key: string, entry: Entry) => {
    if (entries.get(key) === entry) entries.delete(key);
    entry.isDropped = true;
    if (entry.url) deps.revokeUrl(entry.url);
  };

  return {
    // Адрес картинки; `load` зовётся один раз на ключ, пока адрес жив. Каждому `acquire` — свой `release`
    acquire(key: string, load: () => Promise<Blob | undefined>): Promise<string | undefined> {
      const existing = entries.get(key);
      if (existing) {
        deps.clearTimer(existing.timer);
        existing.timer = undefined;
        existing.users++;
        return existing.promise;
      }
      const created: Entry = { users: 1, promise: Promise.resolve(undefined) };
      created.promise = Promise.resolve().then(load).catch(() => undefined).then((blob) => {
        // Не прочиталось — следующая карточка попробует снова
        if (!blob) {
          if (entries.get(key) === created) entries.delete(key);
          return undefined;
        }
        // Все карточки ушли, пока файл читался, и срок вышел — адрес не создаётся
        if (created.isDropped) return undefined;
        created.url = deps.createUrl(blob);
        return created.url;
      });
      entries.set(key, created);
      return created.promise;
    },

    release(key: string) {
      const entry = entries.get(key);
      if (!entry || entry.users <= 0) return;
      entry.users--;
      if (entry.users > 0) return;
      entry.timer = deps.setTimer(() => drop(key, entry), deps.keepMs);
    },

    get size() {
      return entries.size;
    },
  };
}

let shared: ReturnType<typeof createCanvasImageCache> | undefined;

export function getCanvasImageCache() {
  shared ||= createCanvasImageCache({
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number | undefined),
    keepMs: KEEP_MS,
  });
  return shared;
}
