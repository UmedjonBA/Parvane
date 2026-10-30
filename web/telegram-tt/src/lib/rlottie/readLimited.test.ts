import { describe, expect, it } from 'vitest';

import { gzipSync } from 'node:zlib';

import { LottieTooLargeError, readStreamLimited } from './readLimited';

function streamOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('readStreamLimited', () => {
  it('reads a small gzip body', async () => {
    const gz = gzipSync(Buffer.from('{"fr":30}'));
    const text = await readStreamLimited(
      streamOf(new Uint8Array(gz)).pipeThrough(new DecompressionStream('gzip')),
    );
    expect(text).toBe('{"fr":30}');
  });

  it('aborts a gzip bomb above the limit', async () => {
    const gz = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20));
    await expect(readStreamLimited(
      streamOf(new Uint8Array(gz)).pipeThrough(new DecompressionStream('gzip')), 1024 * 1024,
    )).rejects.toBeInstanceOf(LottieTooLargeError);
  });
});
