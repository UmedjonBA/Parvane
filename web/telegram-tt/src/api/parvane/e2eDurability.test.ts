import { beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine } from './e2e';

const TEST_USERS = ['dur-alice@local', 'dur-bob@local'];
const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

describe('E2E decrypt durability', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
    await Promise.all(TEST_USERS.map((user) => E2eEngine.clear(user)));
  });

  it('keeps a sealed message recoverable if the app dies before the inner is cached', async () => {
    const alice = await E2eEngine.create('dur-alice@local');
    let bob = await E2eEngine.create('dur-bob@local');

    const prekeys = bob.buildPrekeysPayload('token')!;
    await bob.flushStorage();
    const oneTime = (prekeys.one_time as { public_key: string }[])[0].public_key;
    const fetchBundle = () => Promise.resolve({
      ok: true,
      identity_key: prekeys.identity_key as string,
      signed_prekey: prekeys.signed_prekey as string,
      one_time: oneTime,
    });
    const innerJson = JSON.stringify({ from: 'dur-alice@local', content: { kind: 'text', text: 'restore me' } });
    const sealedResult = (await alice.encryptForDevices('dur-bob@local', innerJson, fetchBundle))!;
    expect(sealedResult).toBeTruthy();
    const sealed = sealedResult.copies[0];

    // Расшифровка БЕЗ cacheInner — «резкий kill» до атомарного персиста:
    // ратчет уехал только в памяти, на диск попасть не должен
    const plain = bob.decryptFrom(sealedResult.senderIdentity, sealed.ctype, sealed.ciphertext);
    expect(plain).toContain('restore me');
    await bob.flushStorage();

    // Рестарт: ратчет на диске не продвинут — то же sealed читается снова
    bob = await E2eEngine.create('dur-bob@local');
    const again = bob.decryptFrom(sealedResult.senderIdentity, sealed.ctype, sealed.ciphertext);
    expect(again).toContain('restore me');

    // Атомарный персист: cacheInner кладёт inner и продвинутый ратчет одним
    // снапшотом — после рестарта историю читаем из кэша (ратчет уже уехал)
    bob.cacheInner('uuid-durability', { from: 'dur-alice@local', content: { kind: 'text', text: 'restore me' } });
    await bob.flushStorage();
    bob = await E2eEngine.create('dur-bob@local');
    expect(bob.getCachedInner('uuid-durability')?.content).toMatchObject({ text: 'restore me' });
    expect(bob.decryptFrom(sealedResult.senderIdentity, sealed.ctype, sealed.ciphertext)).toBeUndefined();
  });
});
