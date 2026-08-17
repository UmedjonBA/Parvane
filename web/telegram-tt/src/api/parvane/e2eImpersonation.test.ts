import { beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine } from './e2e';

// Регрессия на подмену отправителя: sealed sender скрывает отправителя от
// сервера, но получатель ОБЯЗАН убедиться, что sender_identity действительно
// принадлежит заявленному `inner.from` по каталогу identity. Иначе любой
// пользователь выдал бы себя за любого внутри E2E.
//
// Адреса уникальны на каждый тест: асинхронный persist движка из прошлого теста
// иначе мог бы дописать state поверх очищенного ключа (гонка в тест-хранилище)
const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

function bundleOf(engine: E2eEngine, deviceId: string) {
  const prekeys = engine.buildPrekeysPayload('token')!;
  return {
    device_id: deviceId,
    signing_key: prekeys.signing_key as string,
    identity_key: prekeys.identity_key as string,
    signed_prekey: prekeys.signed_prekey as string,
    one_time: (prekeys.one_time as { public_key: string }[])[0].public_key,
  };
}

describe('E2E sender authenticity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
  });

  it('accepts a sender whose identity is published under their address', async () => {
    const alice = await E2eEngine.create('t1-alice@local');
    const bob = await E2eEngine.create('t1-bob@local');
    const fetchAlice = () => Promise.resolve({ ok: true, devices: [bundleOf(alice, '')] });

    expect(await bob.verifySenderIdentity('t1-alice@local', alice.identityKey, fetchAlice)).toBe('ok');
  });

  it('rejects an identity not owned by the claimed address (impersonation)', async () => {
    const alice = await E2eEngine.create('t2-alice@local');
    const bob = await E2eEngine.create('t2-bob@local');
    const mallory = await E2eEngine.create('t2-mallory@local');
    // Каталог t2-alice возвращает устройства Alice; ключа Mallory там нет,
    // хотя Mallory прислала конверт с inner.from = t2-alice@local
    const fetchAlice = () => Promise.resolve({ ok: true, devices: [bundleOf(alice, '')] });

    expect(await bob.verifySenderIdentity('t2-alice@local', mallory.identityKey, fetchAlice)).toBe('spoofed');
  });

  it('returns unknown when the identity catalog is unreachable', async () => {
    const bob = await E2eEngine.create('t3-bob@local');
    const fetchFail = () => Promise.reject(new Error('offline'));

    expect(await bob.verifySenderIdentity('t3-alice@local', 'some-key', fetchFail)).toBe('unknown');
  });

  it('never authenticates another address as self', async () => {
    const bob = await E2eEngine.create('t4-bob@local');
    const fetchNoop = () => Promise.resolve({ ok: false });

    // Собственный identity-ключ Bob не должен подтверждать чужой адрес
    expect(await bob.verifySenderIdentity('t4-alice@local', bob.identityKey, fetchNoop)).toBe('spoofed');
  });
});
