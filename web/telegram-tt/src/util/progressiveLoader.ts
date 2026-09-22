import { ApiMediaFormat } from '../api/types';

import { callApi } from '../api/gramjs';
import { enforceDecryptedMediaBudget, registerBudgetConsumer } from './parvaneMediaBudget';

const MB = 1024 * 1024;
const DEFAULT_PART_SIZE = 0.25 * MB;
const MAX_END_TO_CACHE = 5 * MB - 1; // We only cache the first 2 MB of each file

// Parvane: окна здесь — РАСШИФРОВАННЫЕ байты медиа, значит они обязаны
// считаться в общем бюджете устройства (spec 002 FR-024). Раньше эта Map росла
// без лимита и не вытеснялась никогда
const bufferCache = new Map<string, ArrayBuffer>();
let bufferCacheBytes = 0;

function dropBufferEntry(key: string) {
  bufferCacheBytes -= bufferCache.get(key)?.byteLength || 0;
  bufferCache.delete(key);
}

registerBudgetConsumer({
  name: 'progressiveLoader',
  usedBytes: () => bufferCacheBytes,
  evictOldest: (protectedKey) => {
    const oldest = Array.from(bufferCache.keys()).find((key) => key !== protectedKey);
    if (oldest === undefined) return false;
    dropBufferEntry(oldest);
    return true;
  },
});
const sizeCache = new Map<string, number>();
const pendingRequests = new Map<string, Promise<{ arrayBuffer?: ArrayBuffer; fullSize?: number } | undefined>>();

export async function* makeProgressiveLoader(
  url: string,
  start = 0,
  chunkSize = DEFAULT_PART_SIZE,
): AsyncGenerator<ArrayBuffer, void, undefined> {
  const match = url.match(/fileSize=(\d+)/);
  let fileSize;
  if (match) {
    fileSize = match && Number(match[1]);
  } else {
    fileSize = sizeCache.get(url);
  }

  while (true) {
    if (fileSize && start >= fileSize) return;

    let end = start + chunkSize - 1;
    if (fileSize && end > fileSize) {
      end = fileSize - 1;
    }

    // Check if we have the chunk in memory
    const cacheKey = `${url}:${start}-${end}`;
    let arrayBuffer = bufferCache.get(cacheKey);

    if (!arrayBuffer) {
      let request = pendingRequests.get(cacheKey);
      if (!request) {
        request = callApi('downloadMedia', {
          mediaFormat: ApiMediaFormat.Progressive,
          url,
          start,
          end,
        });

        pendingRequests.set(cacheKey, request);
      }

      const result = await request.finally(() => {
        pendingRequests.delete(cacheKey);
      });

      if (!result?.arrayBuffer) return;

      // If fileSize is not yet defined, retrieve it from the first chunk's response
      if (result.fullSize && !fileSize) {
        fileSize = result.fullSize;
        sizeCache.set(url, result.fullSize);
      }

      // Store the chunk in memory
      arrayBuffer = result.arrayBuffer;

      // Cache the first chunks of each file
      if (end <= MAX_END_TO_CACHE) {
        if (bufferCache.has(cacheKey)) dropBufferEntry(cacheKey);
        bufferCache.set(cacheKey, result.arrayBuffer);
        bufferCacheBytes += result.arrayBuffer.byteLength;
        enforceDecryptedMediaBudget(cacheKey);
      }
    }

    // Yield the chunk data
    yield arrayBuffer;

    start = end + 1;
  }
}
