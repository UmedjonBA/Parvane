// Загрузка вложения чата потоком (perf A7): шифртекст PVB2 вычисляется из
// кусков файла по требованию (`createCipherSource`, как у «Облака»), уходит
// чанками по ATTACHMENT_CHUNK_BYTES окном из UPLOAD_WINDOW параллельных запросов
// по отдельному соединению блобов; раньше файл целиком лежал в памяти, а чанки
// 192 КиБ шли строго по одному через соединение движка с таймаутом 15 с.
// Формат PVB2 не меняется (размер его чанка записан в заголовке), меняется
// только размер серверного чанка — приёмники читают геометрию с сервера.

import { withRetry } from './cloudBlobs';

/** Серверный чанк вложения, байт шифртекста (лимит шарда cloud — 700 КиБ). */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
const UPLOAD_WINDOW = 3;

export type AttachmentUploadTransport = {
  /** Чанк загрузки; пустой `uploadId` заводит загрузку. Возвращает uploadId. */
  uploadBlobChunk: (uploadId: string, index: number, data: Uint8Array) => Promise<string>;
  /** Завершить загрузку под секретом capability; возвращает file_id. */
  completeBlobUpload: (uploadId: string, chunks: number, size: number, capability: Uint8Array) => Promise<string>;
};

export type CipherSource = {
  cipherSize: number;
  range: (from: number, to: number) => Promise<Uint8Array>;
};

export async function uploadAttachmentStream(
  transport: AttachmentUploadTransport, source: CipherSource, capability: Uint8Array,
  chunkBytes = ATTACHMENT_CHUNK_BYTES,
): Promise<string> {
  const chunks = Math.max(1, Math.ceil(source.cipherSize / chunkBytes));

  async function sendChunk(uploadId: string, index: number) {
    const data = await source.range(index * chunkBytes, (index + 1) * chunkBytes);
    return withRetry(() => transport.uploadBlobChunk(uploadId, index, data));
  }

  // Первый чанк заводит загрузку — остальные знают её id
  const uploadId = await sendChunk('', 0);
  let next = 1;
  let failure: unknown;
  async function worker() {
    while (next < chunks && !failure) {
      const index = next++;
      try {
        await sendChunk(uploadId, index);
      } catch (e) {
        failure = failure || e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_WINDOW, chunks - next) }, worker));
  if (failure) throw failure instanceof Error ? failure : new Error('загрузка вложения не удалась');
  return withRetry(() => transport.completeBlobUpload(uploadId, chunks, source.cipherSize, capability));
}
