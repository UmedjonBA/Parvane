import type {
  ApiOnProgress,
  ApiParsedMedia,
  ApiPreparedMedia,
} from '../api/types';
import {
  ApiMediaFormat,
} from '../api/types';

import {
  DEBUG, MEDIA_CACHE_DISABLED, MEDIA_CACHE_NAME,
  MEDIA_CACHE_NAME_AVATARS,
} from '../config';
import { callApi, cancelApiProgress } from '../api/gramjs';
import {
  IS_OPUS_SUPPORTED, IS_PROGRESSIVE_SUPPORTED,
} from './browser/windowEnvironment';
import * as cacheApi from './cacheApi';
import { fetchBlob } from './files';
import { ACCOUNT_SLOT } from './multiaccount';
import { oggToWav } from './oggToWav';
import { enforceDecryptedMediaBudget, registerBudgetConsumer } from './parvaneMediaBudget';
import { getMediaIdFromUrl } from './parvaneMediaIntegrity';

const asCacheApiType = {
  [ApiMediaFormat.BlobUrl]: cacheApi.Type.Blob,
  [ApiMediaFormat.Text]: cacheApi.Type.Text,
  [ApiMediaFormat.DownloadUrl]: undefined,
  [ApiMediaFormat.Progressive]: undefined,
};

const PROGRESSIVE_URL_PREFIX = './progressive/';
const DOWNLOAD_URL_PREFIX = './download/';
const MAX_MEDIA_RETRIES = 5;

const memoryCache = new Map<string, ApiPreparedMedia>();
// Parvane: расшифрованные блобы под общим бюджетом устройства (FR-024). Map
// хранит порядок вставки, поэтому самый давний — первый ключ
const memorySizeByUrl = new Map<string, number>();
let memoryCacheBytes = 0;

// Вытеснение НЕ отзывает object-URL: тот же URL уже роздан компонентам
// (`<img src>`, `<video src>`, фон чата), и `revokeObjectURL` ломал бы видимую
// картинку — а вытесняется как раз давно загруженное, то есть долгоживущее.
// Отзывать безопасно только со счётчиком ссылок, которого в tt нет; поэтому
// здесь мы лишь перестаём ДЕРЖАТЬ блоб, а освободит его сборщик, когда на него
// не останется ссылок. `revokeForReplacement` — единственное место, где отзыв
// уместен: там URL заведомо никому не отдавался
// Объём записи для бюджета: json lottie-стикеров приходит СТРОКОЙ и раньше
// считался нулём — счётчик занижался, а такие записи вытеснялись первыми,
// освобождая 0 байт и заставляя цикл крутиться вхолостую
function measureMedia(media: unknown): number {
  if (media instanceof Blob) return media.size;
  if (typeof media === 'string') return media.length * 2; // UTF-16 в памяти
  if (media instanceof ArrayBuffer) return media.byteLength;
  return 0;
}

function dropFromMemory(url: string) {
  memoryCache.delete(url);
  memoryCacheBytes -= memorySizeByUrl.get(url) || 0;
  memorySizeByUrl.delete(url);
}

function forgetFromMemory(url: string) {
  dropFromMemory(url);
}

// Путь подмены — единственный, где отзыв object-URL обязателен: уже
// отрисованные `<img src>`/`<video src>` иначе продолжают показывать
// подменённые байты до конца жизни документа, а «перестать держать блоб» их не
// трогает. С вытеснением по бюджету (см. выше) это не смешивать: там URL
// заведомо живой и нужный, и отзыв ломал бы видимую картинку
function revokeTamperedUrl(url: string) {
  const prepared = memoryCache.get(url);
  dropFromMemory(url);
  if (typeof prepared === 'string' && prepared.startsWith('blob:')) URL.revokeObjectURL(prepared);
}

function rememberInMemory(url: string, prepared: ApiPreparedMedia, bytes: number) {
  if (memoryCache.has(url)) dropFromMemory(url);
  memoryCache.set(url, prepared);
  memorySizeByUrl.set(url, bytes);
  memoryCacheBytes += bytes;
  // Свежая запись не должна вытесняться в этом же проходе: иначе файл больше
  // бюджета отзывался бы сразу после создания и качался по кругу
  enforceDecryptedMediaBudget(url);
}

const fetchPromises = new Map<string, Promise<ApiPreparedMedia | undefined>>();
const progressCallbacks = new Map<string, Map<string, ApiOnProgress>>();
const cancellableCallbacks = new Map<string, ApiOnProgress>();

registerBudgetConsumer({
  name: 'mediaLoader',
  usedBytes: () => memoryCacheBytes,
  evictOldest: (protectedKey) => {
    const oldest = Array.from(memorySizeByUrl.keys()).find((key) => key !== protectedKey);
    if (oldest === undefined) return false;
    dropFromMemory(oldest);
    return true;
  },
});

export function fetch<T extends ApiMediaFormat>(
  url: string,
  mediaFormat: T,
  isHtmlAllowed = false,
  onProgress?: ApiOnProgress,
  callbackUniqueId?: string,
): Promise<ApiPreparedMedia> {
  if (mediaFormat === ApiMediaFormat.Progressive) {
    return (
      IS_PROGRESSIVE_SUPPORTED
        ? Promise.resolve(getProgressiveUrl(url))
        : fetch(url, ApiMediaFormat.BlobUrl, isHtmlAllowed, onProgress, callbackUniqueId)
    );
  }

  if (mediaFormat === ApiMediaFormat.DownloadUrl) {
    return (
      IS_PROGRESSIVE_SUPPORTED
        ? Promise.resolve(getDownloadUrl(url))
        : fetch(url, ApiMediaFormat.BlobUrl, isHtmlAllowed, onProgress, callbackUniqueId)
    );
  }

  if (!fetchPromises.has(url)) {
    const promise = fetchFromCacheOrRemote(url, mediaFormat, isHtmlAllowed)
      .catch((err) => {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.warn(err);
        }

        return undefined;
      })
      .finally(() => {
        fetchPromises.delete(url);
        progressCallbacks.delete(url);
        cancellableCallbacks.delete(url);
      });

    fetchPromises.set(url, promise);
  }

  if (onProgress && callbackUniqueId) {
    let activeCallbacks = progressCallbacks.get(url);
    if (!activeCallbacks) {
      activeCallbacks = new Map<string, ApiOnProgress>();
      progressCallbacks.set(url, activeCallbacks);
    }
    activeCallbacks.set(callbackUniqueId, onProgress);
  }

  return fetchPromises.get(url) as Promise<ApiPreparedMedia>;
}

export function getFromMemory(url: string) {
  return memoryCache.get(url) as ApiPreparedMedia;
}

export function cancelProgress(progressCallback: ApiOnProgress) {
  progressCallbacks.forEach((map, url) => {
    map.forEach((callback) => {
      if (callback === progressCallback) {
        const parentCallback = cancellableCallbacks.get(url);
        if (!parentCallback) return;

        cancelApiProgress(parentCallback);
        cancellableCallbacks.delete(url);
        progressCallbacks.delete(url);
        return;
      }
    });
  });
}

export function removeCallback(url: string, callbackUniqueId: string) {
  const callbacks = progressCallbacks.get(url);
  if (!callbacks) return;
  callbacks.delete(callbackUniqueId);
}

export function getProgressiveUrl(url: string) {
  const base = new URL(`${PROGRESSIVE_URL_PREFIX}${url}`, window.location.href);
  if (ACCOUNT_SLOT) base.searchParams.set('account', ACCOUNT_SLOT.toString());
  return base.href;
}

function getDownloadUrl(url: string) {
  const base = new URL(`${DOWNLOAD_URL_PREFIX}${url}`, window.location.href);
  if (ACCOUNT_SLOT) base.searchParams.set('account', ACCOUNT_SLOT.toString());
  return base.href;
}

async function fetchFromCacheOrRemote(
  url: string, mediaFormat: ApiMediaFormat, isHtmlAllowed: boolean, retryNumber = 0,
): Promise<string> {
  if (!MEDIA_CACHE_DISABLED) {
    const cacheName = url.startsWith('avatar') ? MEDIA_CACHE_NAME_AVATARS : MEDIA_CACHE_NAME;
    const cached = await cacheApi.fetch(cacheName, url, asCacheApiType[mediaFormat]!, isHtmlAllowed);

    if (cached) {
      let media = cached;

      if (cached.type === 'audio/ogg' && !IS_OPUS_SUPPORTED) {
        media = await oggToWav(media);
      }

      const prepared = prepareMedia(media);

      rememberInMemory(url, prepared, measureMedia(media));

      return prepared;
    }
  }

  const onProgress = makeOnProgress(url);
  cancellableCallbacks.set(url, onProgress);

  const remote = await callApi('downloadMedia', { url, mediaFormat, isHtmlAllowed }, onProgress);
  if (!remote) {
    if (retryNumber >= MAX_MEDIA_RETRIES) {
      throw new Error(`Failed to fetch media ${url}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, getRetryTimeout(retryNumber));
    });
    // eslint-disable-next-line no-console
    if (DEBUG) console.debug(`Retrying to fetch media ${url}`);
    return fetchFromCacheOrRemote(url, mediaFormat, isHtmlAllowed, retryNumber + 1);
  }

  // Parvane: провайдер отдал не медиа, а отказ проверки целостности — это
  // ошибка на ЛЮБОМ формате, не только на progressive. Без этой ветки объект
  // `{error}` считался успешным ответом: `prepareMedia(undefined)` клал в
  // memoryCache `undefined`, и пузырь крутил спиннер до перезагрузки, а
  // отравленная запись кэша не давала повторить загрузку (spec 002 FR-022)
  if ('error' in remote) {
    throw new Error(`Media ${url} rejected: ${String(remote.error)}`);
  }

  const { mimeType } = remote;
  let prepared = prepareMedia(remote.dataBlob);

  let preparedBytes = measureMedia(remote.dataBlob);
  if (mimeType === 'audio/ogg' && !IS_OPUS_SUPPORTED) {
    const blob = await fetchBlob(prepared);
    URL.revokeObjectURL(prepared);
    const media = await oggToWav(blob);
    prepared = prepareMedia(media);
    preparedBytes = media.size;
  }

  rememberInMemory(url, prepared, preparedBytes);

  return prepared;
}

// Parvane: файл не прошёл проверку целостности — выбросить ВСЕ его
// расшифрованные представления (полный блоб, `?size=` миниатюра, превью).
// Без этого object-URL держал расшифрованные байты живыми после того, как
// API-слой уже вычистил свои кэши (spec 002 FR-022)
export function unloadByFileId(fileId: string) {
  Array.from(memoryCache.keys())
    .filter((url) => getMediaIdFromUrl(url) === fileId)
    .forEach(revokeTamperedUrl);
}

// Parvane: кадр миниатюры доснялся позже бюджета SC-004 — пузырь показывает
// заглушку, отданную к 3 с. Перестаём держать её запись, и следующий запрос
// того же хэша отдаст настоящий кадр. URL здесь НЕ отзываем: заглушка сейчас
// стоит в `<img src>`, и отзыв показал бы битую картинку вместо неё
if (typeof window !== 'undefined') {
  window.addEventListener('parvane-media-thumb', (event) => {
    const fileId = (event as CustomEvent<{ fileId?: string }>).detail?.fileId;
    if (!fileId) return;
    Array.from(memoryCache.keys())
      .filter((url) => /[?&]size=/.test(url) && getMediaIdFromUrl(url) === fileId)
      .forEach(dropFromMemory);
  });
}

export async function unload(url: string) {
  forgetFromMemory(url);
  if (!MEDIA_CACHE_DISABLED) {
    const cacheName = url.startsWith('avatar') ? MEDIA_CACHE_NAME_AVATARS : MEDIA_CACHE_NAME;
    await cacheApi.remove(cacheName, url);
  }
}

function makeOnProgress(url: string) {
  const onProgress: ApiOnProgress = (progress: number) => {
    progressCallbacks.get(url)?.forEach((callback) => {
      callback(progress);
      if (callback.isCanceled) {
        onProgress.isCanceled = true;
        forgetFromMemory(url);
      }
    });
  };

  return onProgress;
}

function prepareMedia(mediaData: Exclude<ApiParsedMedia, ArrayBuffer>): ApiPreparedMedia {
  if (mediaData instanceof Blob) {
    return URL.createObjectURL(mediaData);
  }

  return mediaData;
}

if (IS_PROGRESSIVE_SUPPORTED) {
  navigator.serviceWorker.addEventListener('message', async (e) => {
    const { type, messageId, params } = e.data as {
      type: string;
      messageId: string;
      params: { url: string; start: number; end: number };
    };

    if (type !== 'requestPart') {
      return;
    }

    async function downloadWithRetry(retryNumber = 0) {
      // Обрыв сети роняет `requireConnection()` внутри провайдера — раньше
      // этот бросок улетал наружу, `partResponse` не отправлялся вовсе, и
      // сервис-воркер молча ждал PART_TIMEOUT (минуту), что запрещает FAIL-1
      const result = await callApi('downloadMedia', { mediaFormat: ApiMediaFormat.Progressive, ...params })
        .catch(() => undefined);
      // Parvane: файл не прошёл проверку целостности — без ретраев
      if (result && 'error' in result) return result;
      if (!result) {
        if (retryNumber >= MAX_MEDIA_RETRIES) {
          if (DEBUG) {
            // eslint-disable-next-line no-console
            console.warn(`Failed to download media part after ${MAX_MEDIA_RETRIES} retries:`, params.url);
          }
          return undefined;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, getRetryTimeout(retryNumber));
        });
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.debug(`Retrying to download media part ${params.url}, attempt ${retryNumber + 1}`);
        }
        return downloadWithRetry(retryNumber + 1);
      }
      return result;
    }

    const result = await downloadWithRetry();
    if (!result) {
      // Ответить ОБЯЗАТЕЛЬНО: иначе плеер висит до PART_TIMEOUT вместо того,
      // чтобы остановиться с возможностью продолжить
      navigator.serviceWorker.controller!.postMessage({
        type: 'partResponse',
        messageId,
        error: 'MEDIA_UNAVAILABLE',
      });
      return;
    }

    if ('error' in result) {
      // Parvane: сервис-воркер сразу отвечает ошибкой вместо 60-с ожидания
      navigator.serviceWorker.controller!.postMessage({
        type: 'partResponse',
        messageId,
        error: String(result.error),
      });
      return;
    }

    const { arrayBuffer, mimeType, fullSize } = result;

    navigator.serviceWorker.controller!.postMessage({
      type: 'partResponse',
      messageId,
      result: {
        arrayBuffer,
        mimeType,
        fullSize,
      },
    }, [arrayBuffer!]);
  });
}

function getRetryTimeout(retryNumber: number) {
  // 250ms, 500ms, 1s, 2s, 4s
  return 250 * 2 ** retryNumber;
}
