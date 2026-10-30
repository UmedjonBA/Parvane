// Предел распакованного JSON анимации (gzip-бомба из стикера не должна ронять воркер)
export const MAX_LOTTIE_JSON_BYTES = 8 * 1024 * 1024;

export class LottieTooLargeError extends Error {}

/**
 * Читает поток целиком в строку, прерывая чтение, как только набралось больше `maxBytes` байт.
 */
export async function readStreamLimited(
  stream: ReadableStream<Uint8Array>, maxBytes = MAX_LOTTIE_JSON_BYTES,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw new LottieTooLargeError('Lottie JSON is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const all = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder().decode(all);
}
