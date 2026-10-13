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
  // Сколько файлов читается одновременно (остальные ждут в очереди) и сколько байт картинок держится разом:
  // сверх предела первыми уходят адреса без карточек, не дожидаясь срока
  maxLoads?: number;
  maxBytes?: number;
};

type Entry = {
  promise: Promise<string | undefined>;
  users: number;
  url?: string;
  bytes: number;
  timer?: unknown;
  isDropped?: boolean;
  // Порядок ухода последней карточки — первым освобождается давно не нужный
  freedAt: number;
};

// Картинка больше этого в карточку целиком не читается — остаётся миниатюра (сам файл открывает просмотр)
export const CANVAS_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
// Общий предел памяти под картинки холста и число одновременных чтений файлов
export const CANVAS_IMAGES_MAX_BYTES = 192 * 1024 * 1024;
export const CANVAS_IMAGE_MAX_LOADS = 3;
// Карточка уже этого на экране показывает миниатюру: полный файл на ней не разглядеть
export const CANVAS_FULL_IMAGE_MIN_PX = 320;
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
  const maxLoads = Math.max(1, deps.maxLoads ?? CANVAS_IMAGE_MAX_LOADS);
  const maxBytes = deps.maxBytes ?? CANVAS_IMAGES_MAX_BYTES;
  const waiting: (() => void)[] = [];
  let loading = 0;
  let totalBytes = 0;
  let freedCount = 0;

  const drop = (key: string, entry: Entry) => {
    if (entries.get(key) === entry) entries.delete(key);
    deps.clearTimer(entry.timer);
    entry.timer = undefined;
    entry.isDropped = true;
    totalBytes -= entry.bytes;
    entry.bytes = 0;
    if (entry.url) deps.revokeUrl(entry.url);
  };

  // Память сверх предела: уходят адреса, у которых не осталось карточек, — давно свободные первыми
  const trim = () => {
    while (totalBytes > maxBytes) {
      let oldest: [string, Entry] | undefined;
      entries.forEach((entry, key) => {
        if (entry.users > 0 || !entry.url) return;
        if (!oldest || entry.freedAt < oldest[1].freedAt) oldest = [key, entry];
      });
      if (!oldest) return;
      drop(oldest[0], oldest[1]);
    }
  };

  // Очередь чтения: не больше `maxLoads` файлов разом
  const next = () => {
    while (loading < maxLoads && waiting.length) {
      loading++;
      waiting.shift()!();
    }
  };
  const enqueue = (load: () => Promise<Blob | undefined>) => new Promise<Blob | undefined>((resolve) => {
    waiting.push(() => {
      Promise.resolve().then(load).catch(() => undefined).then((blob) => {
        loading--;
        resolve(blob);
        next();
      });
    });
    next();
  });

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
      const created: Entry = {
        users: 1, promise: Promise.resolve(undefined), bytes: 0, freedAt: 0,
      };
      created.promise = enqueue(load).then((blob) => {
        // Не прочиталось — следующая карточка попробует снова
        if (!blob) {
          if (entries.get(key) === created) entries.delete(key);
          return undefined;
        }
        // Все карточки ушли, пока файл читался, и срок вышел — адрес не создаётся
        if (created.isDropped) return undefined;
        created.url = deps.createUrl(blob);
        created.bytes = blob.size;
        totalBytes += blob.size;
        trim();
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
      entry.freedAt = ++freedCount;
      entry.timer = deps.setTimer(() => drop(key, entry), deps.keepMs);
      trim();
    },

    get size() {
      return entries.size;
    },

    get bytes() {
      return totalBytes;
    },

    // Сколько чтений идёт и ждёт — для тестов очереди
    get pending() {
      return loading + waiting.length;
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
