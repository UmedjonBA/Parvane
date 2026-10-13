import { describe, expect, it } from 'vitest';

import { bytesToBase64 } from './v2/base64';
import { ATTACHMENT_CHUNK_BYTES, uploadAttachmentStream } from './attachmentUpload';
import { decryptBlob } from './blobcrypt';
import { createCipherSource } from './cloudBlobs';

function makeTransport() {
  const received = new Map<number, Uint8Array>();
  let inFlight = 0;
  let peak = 0;
  const order: number[] = [];
  let completed: { uploadId: string; chunks: number; size: number } | undefined;
  return {
    received,
    order,
    peak: () => peak,
    completed: () => completed,
    transport: {
      uploadBlobChunk: async (uploadId: string, index: number, data: Uint8Array) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        order.push(index);
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
        received.set(index, data);
        inFlight -= 1;
        return uploadId || 'upl-1';
      },
      completeBlobUpload: (uploadId: string, chunks: number, size: number) => {
        completed = { uploadId, chunks, size };
        return Promise.resolve('file-1');
      },
    },
  };
}

describe('attachment upload stream (perf A7)', () => {
  it('streams PVB2 in fixed server chunks, first alone, then a window of three', async () => {
    // Серверный чанк в тесте — 128 КиБ (в бою ATTACHMENT_CHUNK_BYTES): геометрия
    // та же, а шифрование в jsdom укладывается в бюджет теста
    const chunkBytes = 128 * 1024;
    expect(ATTACHMENT_CHUNK_BYTES).toBe(512 * 1024);
    const plain = new Uint8Array(300_000);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 31) & 0xff;
    const key = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const source = createCipherSource(new Blob([plain]), key, nonce);
    const fake = makeTransport();

    const fileId = await uploadAttachmentStream(fake.transport, source, new Uint8Array(32), chunkBytes);
    expect(fileId).toBe('file-1');
    const chunks = Math.ceil(source.cipherSize / chunkBytes);
    expect(chunks).toBe(3);
    expect(fake.order[0]).toBe(0);
    expect(fake.peak()).toBeLessThanOrEqual(3);
    expect(fake.completed()).toEqual({ uploadId: 'upl-1', chunks, size: source.cipherSize });

    // Склеенные серверные чанки — тот же PVB2, что читают приёмники
    const cipher = new Uint8Array(source.cipherSize);
    let offset = 0;
    for (let index = 0; index < chunks; index++) {
      const part = fake.received.get(index)!;
      expect(part.length).toBeLessThanOrEqual(chunkBytes);
      cipher.set(part, offset);
      offset += part.length;
    }
    expect(offset).toBe(source.cipherSize);
    const decrypted = await decryptBlob(cipher, bytesToBase64(key), bytesToBase64(nonce));
    expect(decrypted).toEqual(plain);
  });

  it('uploads an empty file as a single chunk', async () => {
    const source = createCipherSource(new Blob([]), new Uint8Array(32), new Uint8Array(12));
    const fake = makeTransport();
    await uploadAttachmentStream(fake.transport, source, new Uint8Array(32));
    expect(fake.received.size).toBe(1);
    expect(fake.completed()?.chunks).toBe(1);
  });
});
