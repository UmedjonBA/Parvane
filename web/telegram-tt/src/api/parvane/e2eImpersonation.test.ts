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
    signed_prekey_sig: prekeys.signed_prekey_sig as string,
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

  // T196: история, отправленная со своего устройства, которое позже отозвали.
  // Ключа отозванного устройства в каталоге уже нет, но оно было подтверждено
  // раньше — старые сообщения должны читаться, новые от него — нет
  it('keeps history from a revoked own device readable, but not new messages from it', async () => {
    const self = 't5-bob@local';
    const oldDevice = await E2eEngine.create(self);
    const sibling = await E2eEngine.create('t5-sibling@local');
    // Бандлы строим один раз: повторная сборка прекеев отдаёт уже опубликованные
    const siblingBundle = bundleOf(sibling, 'sib');
    const otherBundle = bundleOf(await E2eEngine.create('t5-other@local'), 'other');
    const withSibling = () => Promise.resolve({ ok: true, devices: [siblingBundle] });
    const withoutSibling = () => Promise.resolve({ ok: true, devices: [otherBundle] });

    // Пока устройство в каталоге — подтверждено и запомнено
    expect(await oldDevice.verifySenderIdentity(self, sibling.identityKey, withSibling)).toBe('ok');
    oldDevice.rememberVerifiedIdentity(self, sibling.identityKey);
    oldDevice.cacheInner('m-1', {
      from: self, content: { kind: 'text', text: 'x' }, senderIdentity: sibling.identityKey,
    });
    // Устройство отозвано: старое устройство перечитало каталог, ключа в нём больше нет
    expect(await oldDevice.verifySenderIdentity(self, 'unknown-key', withoutSibling)).toBe('spoofed');

    // Новое устройство получает историю линковкой; отозванного устройства в каталоге нет
    const newDevice = await E2eEngine.create('t5-bob-new@local');
    oldDevice.rememberHistoryIdentities(['m-1']);
    newDevice.importLinkedHistory(oldDevice.exportLinkStateJson());

    expect(await newDevice.verifySenderIdentity(self, sibling.identityKey, withoutSibling, true)).toBe('ok');
    expect(await newDevice.verifySenderIdentity(self, sibling.identityKey, withoutSibling)).toBe('spoofed');
  });

  it('does not accept an unknown identity as history', async () => {
    const self = 't6-bob@local';
    const device = await E2eEngine.create(self);
    const mallory = await E2eEngine.create('t6-mallory@local');
    const otherBundle = bundleOf(await E2eEngine.create('t6-other@local'), 'other');
    const catalog = () => Promise.resolve({ ok: true, devices: [otherBundle] });

    expect(await device.verifySenderIdentity(self, mallory.identityKey, catalog, true)).toBe('spoofed');
  });
});
