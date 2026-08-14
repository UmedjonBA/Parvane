import { beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine } from './e2e';

// Каждый движок в тесте — отдельное «устройство»; отдельные storage-адреса
// эмулируют разные браузеры, а логический адрес задаётся в inner/фетчере
const TEST_USERS = ['md-alice@local', 'md-alice-b@local', 'md-bob@local', 'md-bob-b@local'];
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

describe('E2E multidevice fan-out', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
    await Promise.all(TEST_USERS.map((user) => E2eEngine.clear(user)));
  });

  it('encrypts a copy for every recipient device and own second device', async () => {
    const alice = await E2eEngine.create('md-alice@local');
    const aliceB = await E2eEngine.create('md-alice-b@local');
    const bob = await E2eEngine.create('md-bob@local');
    const bobB = await E2eEngine.create('md-bob-b@local');

    expect(alice.deviceId).toBeTruthy();

    const bobDevices = [bundleOf(bob, 'dev-b1'), bundleOf(bobB, 'dev-b2')];
    const fetchBobBundles = () => Promise.resolve({ ok: true, devices: bobDevices });
    const inner = JSON.stringify({ from: 'md-alice@local', content: { kind: 'text', text: 'fan out' } });

    const sealed = (await alice.encryptForDevices('md-bob@local', inner, fetchBobBundles))!;
    expect(sealed.copies.map((copy) => copy.deviceId).sort()).toEqual(['dev-b1', 'dev-b2']);

    // Каждое устройство bob читает СВОЮ копию (и не читает чужую)
    const forB1 = sealed.copies.find((copy) => copy.deviceId === 'dev-b1')!;
    const forB2 = sealed.copies.find((copy) => copy.deviceId === 'dev-b2')!;
    expect(bob.decryptFrom(sealed.senderIdentity, forB1.ctype, forB1.ciphertext)).toContain('fan out');
    expect(bobB.decryptFrom(sealed.senderIdentity, forB2.ctype, forB2.ciphertext)).toContain('fan out');
    expect(bob.decryptFrom(sealed.senderIdentity, forB2.ctype, forB2.ciphertext)).toBeUndefined();

    // Свои устройства: копия для второго, СВОЁ текущее исключено
    const aliceDevices = [bundleOf(aliceB, 'dev-a2'), {
      device_id: alice.deviceId,
      identity_key: alice.identityKey,
      signed_prekey: 'unused',
      one_time: 'unused',
    }];
    const fetchAliceBundles = () => Promise.resolve({ ok: true, devices: aliceDevices });
    const selfSealed = (await alice.encryptForDevices(
      'md-alice@local', inner, fetchAliceBundles, alice.deviceId,
    ))!;
    expect(selfSealed.copies.map((copy) => copy.deviceId)).toEqual(['dev-a2']);
    const forA2 = selfSealed.copies[0];
    expect(forA2.deviceSigningKey).toBe(aliceB.signingKey);
    expect(aliceB.decryptFrom(selfSealed.senderIdentity, forA2.ctype, forA2.ciphertext)).toContain('fan out');

    // Устройства с установленной сессией стали known — их one-time при
    // следующем fetch не расходуются
    expect(alice.getKnownDeviceIds('md-bob@local').sort()).toEqual(['dev-b1', 'dev-b2']);
  });

  it('keeps sending via cached sessions when the bundle fetch fails', async () => {
    const alice = await E2eEngine.create('md-alice@local');
    const bob = await E2eEngine.create('md-bob@local');
    const devices = [bundleOf(bob, 'dev-b1')];
    const inner = JSON.stringify({ from: 'md-alice@local', content: { kind: 'text', text: 'offline list' } });

    const first = await alice.encryptForDevices(
      'md-bob@local', inner, () => Promise.resolve({ ok: true, devices }),
    );
    expect(first?.copies).toHaveLength(1);

    // Список устройств недоступен (сеть) — шлём по уже известным сессиям
    const second = (await alice.encryptForDevices(
      'md-bob@local', inner, () => Promise.reject(new Error('offline')),
    ))!;
    expect(second.copies).toHaveLength(1);
    expect(bob.decryptFrom(
      second.senderIdentity, second.copies[0].ctype, second.copies[0].ciphertext,
    )).toContain('offline list');
  });
});
