import { describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64 } from './base64';

describe('base64 in chunks (perf A7)', () => {
  it('round-trips empty, short and multi-window inputs', () => {
    for (const size of [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 200_000]) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 3) & 0xff;
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')));
      expect(base64ToBytes(encoded)).toEqual(bytes);
    }
  });
});
