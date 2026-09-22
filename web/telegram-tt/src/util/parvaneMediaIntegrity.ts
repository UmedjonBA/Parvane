// Parvane: файлы, не прошедшие проверку целостности (spec 002 FR-022).
// API-слой шлёт window-событие `parvane-media-integrity {fileId}`; UI помечает
// файл, пузырь и плеер снимают src и показывают состояние ошибки.
import { useEffect, useState } from '../lib/teact/teact';

import { CUSTOM_BG_CACHE_NAME, MEDIA_PROGRESSIVE_CACHE_NAME } from '../config';
import { callApi } from '../api/gramjs';
import { ACCOUNT_SLOT } from './multiaccount';

const tamperedFileIds = new Set<string>();
const listeners = new Set<() => void>();

export function markMediaTampered(fileId: string) {
  if (tamperedFileIds.has(fileId)) return;
  tamperedFileIds.add(fileId);
  listeners.forEach((listener) => listener());
}

export function isMediaTampered(fileId?: string) {
  return Boolean(fileId && tamperedFileIds.has(fileId));
}

// id медиа из хэша/URL tt: document<id>, photo<id>, wallpaper<id> (progressive
// — с префиксом пути). Набор префиксов тот же, что у MEDIA_URL_REGEX в
// `api/parvane/media.ts`: иначе подменённые обои не сбрасывались бы из кэшей
export function getMediaIdFromUrl(url?: string) {
  return url?.match(/(?:document|photo|wallpaper)([\w-]+?)(?:\?|$)/)?.[1];
}

// Настоящий старт воспроизведения (событие `play` у <video>): от него
// отсчитывается отсрочка фоновой докачки (spec 002 SC-003)
export function notifyMediaPlaying(url?: string) {
  const fileId = getMediaIdFromUrl(url);
  if (fileId) window.dispatchEvent(new CustomEvent('parvane-media-playing', { detail: { fileId } }));
}

export function useParvaneMediaTampered(fileId?: string) {
  const [isTampered, setIsTampered] = useState(() => isMediaTampered(fileId));
  useEffect(() => {
    if (!fileId) return undefined;
    const listener = () => setIsTampered(isMediaTampered(fileId));
    listener();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [fileId]);
  return isTampered;
}

// Старые сборки писали открытые части потокового медиа в Cache Storage
// (первые 2 МБ аудио/видео) — вычищаем кэши всех слотов аккаунтов
const PROGRESSIVE_CACHE_NAME = MEDIA_PROGRESSIVE_CACHE_NAME;
const ACCOUNT_SLOTS = 6;

export async function purgePlaintextMediaCaches() {
  if (typeof caches === 'undefined') return;
  const names = [PROGRESSIVE_CACHE_NAME];
  for (let slot = 1; slot <= ACCOUNT_SLOTS; slot++) names.push(`${PROGRESSIVE_CACHE_NAME}_${slot}`);
  if (ACCOUNT_SLOT && !names.includes(`${PROGRESSIVE_CACHE_NAME}_${ACCOUNT_SLOT}`)) {
    names.push(`${PROGRESSIVE_CACHE_NAME}_${ACCOUNT_SLOT}`);
  }
  await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
}

// Свой фон чата тоже лежал открытым блобом в Cache Storage. Прежде чем удалять
// этот кэш, содержимое НУЖНО перенести в шифрованное хранилище — иначе у
// пользователя, поставившего обои до этой фичи, пропадёт единственная копия
// (FR-023). Удаляем кэш только после успешного переноса
export async function migrateCustomBackgrounds() {
  if (typeof caches === 'undefined') return;
  const names = [CUSTOM_BG_CACHE_NAME];
  for (let slot = 1; slot <= ACCOUNT_SLOTS; slot++) names.push(`${CUSTOM_BG_CACHE_NAME}_${slot}`);

  for (const name of names) {
    const exists = await caches.has(name).catch(() => false);
    if (!exists) continue;
    let isMigrated = true;
    try {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      for (const request of requests) {
        // Ключ записи — имя темы (light/dark)
        const theme = request.url.split('/').pop();
        if (!theme) continue;
        const response = await cache.match(request);
        const blob = await response?.blob();
        if (!blob) continue;
        const result = await (callApi as unknown as (
          method: string, args: { theme: string; bytes: ArrayBuffer; mimeType: string },
        ) => Promise<{ status: string } | undefined>)('saveChatBackground', {
          theme, bytes: await blob.arrayBuffer(), mimeType: blob.type || 'image/jpeg',
        });
        // Провайдер ещё не готов или запись не удалась — кэш НЕ трогаем,
        // попробуем на следующем запуске
        if (result?.status !== 'ok') isMigrated = false;
      }
    } catch {
      isMigrated = false;
    }
    if (isMigrated) await caches.delete(name).catch(() => false);
  }
}
