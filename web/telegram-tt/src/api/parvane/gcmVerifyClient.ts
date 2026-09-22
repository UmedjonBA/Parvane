// Клиент воркера проверки тега GCM. Один воркер на вкладку, запросы
// последовательные (планировщик mediaIntegrity держит одну задачу за раз).
// Без Worker (тестовое окружение) — та же проверка в текущем потоке.
import type { GcmWorkerRequest, GcmWorkerResponse } from './gcmVerify.worker';
import type { StreamingVerifier } from './mediaIntegrity';

import { deriveGhashKeys } from './blobcrypt';
import { createGcmTagVerifier } from './gcmVerify';

let worker: Worker | undefined;
const waiters = new Map<string, Array<(response: GcmWorkerResponse) => void>>();
let jobCounter = 0;

function getWorker() {
  if (worker || typeof Worker === 'undefined') return worker;
  worker = new Worker(new URL('./gcmVerify.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<GcmWorkerResponse>) => {
    const queue = waiters.get(event.data.jobId);
    const resolve = queue?.shift();
    if (queue && !queue.length) waiters.delete(event.data.jobId);
    resolve?.(event.data);
  };
  return worker;
}

function send(target: Worker, request: GcmWorkerRequest, transfer: Transferable[] = []) {
  return new Promise<GcmWorkerResponse>((resolve) => {
    const queue = waiters.get(request.jobId) || [];
    queue.push(resolve);
    waiters.set(request.jobId, queue);
    target.postMessage(request, transfer);
  });
}

export async function createStreamingGcmVerifier(
  keyB64: string, nonceB64: string, sizeBytes: number,
): Promise<StreamingVerifier> {
  const keys = await deriveGhashKeys(keyB64, nonceB64);
  const target = getWorker();
  if (!target) {
    const local = createGcmTagVerifier(keys, sizeBytes);
    return { update: (bytes) => local.update(bytes), finish: () => local.finish() };
  }
  const jobId = `gcm-${++jobCounter}`;
  const ready = await send(target, {
    type: 'init', jobId, h: keys.h, ej0: keys.ej0, sizeBytes,
  });
  if (ready.type !== 'ready') throw new Error(ready.type === 'error' ? ready.message : 'воркер проверки не готов');
  let failed = false;
  return {
    async update(bytes) {
      if (failed) return;
      const copy = bytes.slice();
      const response = await send(target, { type: 'chunk', jobId, bytes: copy }, [copy.buffer]);
      if (response.type === 'error') failed = true;
    },
    async finish() {
      if (failed) return false;
      const response = await send(target, { type: 'finish', jobId });
      return response.type === 'result' && response.ok;
    },
    dispose() {
      target.postMessage({ type: 'drop', jobId } satisfies GcmWorkerRequest);
    },
  };
}
