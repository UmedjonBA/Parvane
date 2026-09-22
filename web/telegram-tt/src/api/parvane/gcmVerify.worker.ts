// Воркер потоковой проверки тега GCM (gcmVerify.ts): GHASH над сотнями
// мегабайт не должен занимать главный поток, где живёт провайдер и UI.
// Состояние проверки на паузе остаётся здесь — объект GHASH не сериализуется.
import type { GcmTagVerifier } from './gcmVerify';

import { createGcmTagVerifier } from './gcmVerify';

export type GcmWorkerRequest =
  | { type: 'init'; jobId: string; h: Uint8Array; ej0: Uint8Array; sizeBytes: number }
  | { type: 'chunk'; jobId: string; bytes: Uint8Array }
  | { type: 'finish'; jobId: string }
  | { type: 'drop'; jobId: string };

export type GcmWorkerResponse =
  | { type: 'ready'; jobId: string }
  | { type: 'ack'; jobId: string }
  | { type: 'result'; jobId: string; ok: boolean }
  | { type: 'error'; jobId: string; message: string };

const verifiers = new Map<string, GcmTagVerifier>();

function reply(message: GcmWorkerResponse) {
  (self as unknown as { postMessage: (value: GcmWorkerResponse) => void }).postMessage(message);
}

self.onmessage = (event: MessageEvent<GcmWorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'init':
        verifiers.set(request.jobId, createGcmTagVerifier({ h: request.h, ej0: request.ej0 }, request.sizeBytes));
        reply({ type: 'ready', jobId: request.jobId });
        break;
      case 'chunk': {
        const verifier = verifiers.get(request.jobId);
        if (!verifier) throw new Error('нет проверки');
        verifier.update(request.bytes);
        reply({ type: 'ack', jobId: request.jobId });
        break;
      }
      case 'finish': {
        const verifier = verifiers.get(request.jobId);
        verifiers.delete(request.jobId);
        reply({ type: 'result', jobId: request.jobId, ok: Boolean(verifier?.finish()) });
        break;
      }
      case 'drop':
        verifiers.delete(request.jobId);
        break;
      default:
        break;
    }
  } catch (error) {
    verifiers.delete(request.jobId);
    reply({ type: 'error', jobId: request.jobId, message: error instanceof Error ? error.message : String(error) });
  }
};
