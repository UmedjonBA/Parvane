import { describe, expect, it } from 'vitest';

import { deriveGroupPhotoKeys } from './groupPhoto';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('фото частной группы (GPHOTO-1)', () => {
  it('ключи выводятся по общему вектору', async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const keys = await deriveGroupPhotoKeys(secret);
    expect(hex(keys.capability)).toBe('19cd81b03ce6d287485c70b72571c74a2edac62fd5418737d7edc6b55f8411e3');
    expect(hex(keys.key)).toBe('9afab6a58c6441be27962c9ee7ac075a4506252d4d840268bd3a33601e665e42');
    expect(hex(keys.nonce)).toBe('af79ac7f89284db688e10912');
  });

  it('секрет не 32 байта отвергается', async () => {
    await expect(deriveGroupPhotoKeys(new Uint8Array(5))).rejects.toThrow();
  });
});
