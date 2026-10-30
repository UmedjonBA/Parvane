import { describe, expect, it } from 'vitest';

import { PASSCODE_IDB_STORE } from './browser/idb';
import {
  clearEncryptedSession, decryptSession, encryptSession, setupPasscode,
} from './passcode';

describe('passcode key derivation', () => {
  it('roundtrips and stores a per-install random salt', async () => {
    await setupPasscode('1234');
    await encryptSession('{"s":1}', '{"g":1}', '{"h":1}');
    const salt = await PASSCODE_IDB_STORE.get<number[]>('kdfSalt');
    expect(salt).toHaveLength(16);
    const out = await decryptSession('1234');
    expect(out.sessionJson).toBe('{"s":1}');
    await expect(decryptSession('4321')).rejects.toBeDefined();
    await clearEncryptedSession();
  });

  it('uses a different salt per setup (no shared constant salt)', async () => {
    await setupPasscode('1234');
    const first = await PASSCODE_IDB_STORE.get<number[]>('kdfSalt');
    await setupPasscode('1234');
    const second = await PASSCODE_IDB_STORE.get<number[]>('kdfSalt');
    expect(first).not.toEqual(second);
    await clearEncryptedSession();
  });

  it('migrates a legacy sha256-keyed session to the salted key', async () => {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode('1234harder better faster stronger'));
    const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt']);
    const put = async (name: string, text: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
      const all = new Uint8Array(12 + ct.length);
      all.set(iv);
      all.set(ct, 12);
      await PASSCODE_IDB_STORE.set(name, Array.from(all));
    };
    await put('sessionEncrypted', '{"s":2}');
    await put('globalEncrypted', '{"g":2}');
    await PASSCODE_IDB_STORE.del('kdfSalt');

    expect((await decryptSession('1234')).sessionJson).toBe('{"s":2}');
    expect(await PASSCODE_IDB_STORE.get('kdfSalt')).toBeDefined();
    expect((await decryptSession('1234')).globalJson).toBe('{"g":2}');
    await clearEncryptedSession();
  });
});
