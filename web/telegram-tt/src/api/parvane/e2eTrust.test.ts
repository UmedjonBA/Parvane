import { beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine, verifyPrekeySignature } from './e2e';

// P-04 (TOFU): смена identity-ключа контакта определяется по множеству уже
// виденных ключей, которое каталог НЕ засевает после первого знакомства —
// сервер, подменивший identity, не может спрятать предупреждение о смене.
// P-25: signed_prekey из каталога принимается только с валидной подписью
// signing_key устройства — подменённый SPK не даёт сессии (и не даёт «spoofed»).
const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

// buildPrekeysPayload отдаёт бандл один раз (published) — кэшируем по движку
const prekeysCache = new WeakMap<E2eEngine, Record<string, unknown>>();
function bundleOf(engine: E2eEngine, deviceId: string, tamper?: Partial<Record<string, string>>) {
  let prekeys = prekeysCache.get(engine);
  if (!prekeys) {
    prekeys = engine.buildPrekeysPayload('token')!;
    prekeysCache.set(engine, prekeys);
  }
  return {
    device_id: deviceId,
    signing_key: prekeys.signing_key as string,
    identity_key: prekeys.identity_key as string,
    signed_prekey: prekeys.signed_prekey as string,
    signed_prekey_sig: prekeys.signed_prekey_sig as string,
    one_time: (prekeys.one_time as { public_key: string }[])[0].public_key,
    ...tamper,
  };
}

describe('P-04: смена ключа контакта по виденным identity (TOFU)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
  });

  it('первое знакомство через каталог — не смена; подмена identity сервером — смена', async () => {
    const alice = await E2eEngine.create('p04-alice@local');
    const bob = await E2eEngine.create('p04-bob@local');
    const mallory = await E2eEngine.create('p04-mallory@local');

    const fetchAlice = () => Promise.resolve({ ok: true, devices: [bundleOf(alice, 'a1')] });
    expect(await bob.verifySenderIdentity('p04-alice@local', alice.identityKey, fetchAlice)).toBe('ok');
    expect(bob.rememberContactIdentity('p04-alice@local', alice.identityKey)).toBe(false);
    expect(bob.getSeenIdentities('p04-alice@local')).toEqual([alice.identityKey]);

    // Сервер теперь отдаёт под адресом alice ключ mallory: verify по каталогу
    // проходит (каталог — источник истины для «чей ключ»), но пользователь
    // ОБЯЗАН увидеть предупреждение о смене ключа
    const fetchSwapped = () => Promise.resolve({ ok: true, devices: [bundleOf(mallory, 'a1')] });
    expect(await bob.verifySenderIdentity('p04-alice@local', mallory.identityKey, fetchSwapped)).toBe('ok');
    expect(bob.rememberContactIdentity('p04-alice@local', mallory.identityKey)).toBe(true);
    // Повтор того же ключа — уже виденный
    expect(bob.rememberContactIdentity('p04-alice@local', mallory.identityKey)).toBe(false);
    // Старый ключ остаётся в виденных (возврат к нему — не «новая» смена)
    expect(bob.getSeenIdentities('p04-alice@local').sort())
      .toEqual([alice.identityKey, mallory.identityKey].sort());
  });

  it('виденные identity переживают перезагрузку движка', async () => {
    const alice = await E2eEngine.create('p04r-alice@local');
    let bob = await E2eEngine.create('p04r-bob@local');
    expect(bob.rememberContactIdentity('p04r-alice@local', alice.identityKey)).toBe(false);
    await bob.flushStorage();

    bob = await E2eEngine.create('p04r-bob@local');
    expect(bob.getSeenIdentities('p04r-alice@local')).toEqual([alice.identityKey]);
    expect(bob.rememberContactIdentity('p04r-alice@local', alice.identityKey)).toBe(false);
    const other = await E2eEngine.create('p04r-other@local');
    expect(bob.rememberContactIdentity('p04r-alice@local', other.identityKey)).toBe(true);
  });

  it('виденные identity уезжают в экспорт линковки и принимаются при импорте', async () => {
    const alice = await E2eEngine.create('p04m-alice@local');
    const bob = await E2eEngine.create('p04m-bob@local');
    bob.rememberContactIdentity('p04m-alice@local', alice.identityKey);
    const exported = JSON.parse(bob.exportLinkStateJson()) as { seenIdentities: Record<string, string[]> };
    expect(exported.seenIdentities['p04m-alice@local']).toEqual([alice.identityKey]);
    const fresh = await E2eEngine.create('p04m-fresh@local');
    fresh.importLinkedHistory(bob.exportLinkStateJson());
    expect(fresh.getSeenIdentities('p04m-alice@local')).toEqual([alice.identityKey]);
    // На новом устройстве тот же ключ — не смена, другой — смена
    expect(fresh.rememberContactIdentity('p04m-alice@local', alice.identityKey)).toBe(false);
    const other = await E2eEngine.create('p04m-other@local');
    expect(fresh.rememberContactIdentity('p04m-alice@local', other.identityKey)).toBe(true);
  });
});

describe('P-25: signed_prekey принимается только с подписью signing_key', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
  });

  it('verifyPrekeySignature: валидная подпись — ok, подмена SPK/подписи/ключа — нет', async () => {
    const alice = await E2eEngine.create('p25-alice@local');
    const mallory = await E2eEngine.create('p25-mallory@local');
    const good = bundleOf(alice, 'a1');
    expect(verifyPrekeySignature(good)).toBe(true);
    expect(verifyPrekeySignature({ ...good, signed_prekey: bundleOf(mallory, 'm').signed_prekey })).toBe(false);
    expect(verifyPrekeySignature({ ...good, signed_prekey_sig: bundleOf(mallory, 'm').signed_prekey_sig })).toBe(false);
    expect(verifyPrekeySignature({ ...good, signing_key: mallory.signingKey })).toBe(false);
    expect(verifyPrekeySignature({ ...good, signed_prekey_sig: '' })).toBe(false);
    expect(verifyPrekeySignature({ ...good, signing_key: undefined })).toBe(false);
  });

  it('устройство с подменённым SPK не получает сессию, вердикт unknown, а не spoofed', async () => {
    const alice = await E2eEngine.create('p25b-alice@local');
    const bob = await E2eEngine.create('p25b-bob@local');
    const mallory = await E2eEngine.create('p25b-mallory@local');
    // Сервер подменил SPK alice на свой (подпись alice под ним не сходится)
    const swapped = bundleOf(alice, 'a1', { signed_prekey: bundleOf(mallory, 'm').signed_prekey });
    const fetchSwapped = () => Promise.resolve({ ok: true, devices: [swapped] });
    expect(await bob.encryptForDevices('p25b-alice@local', { kind: 'text', text: 'x' }, fetchSwapped)).toBeUndefined();
    expect(await bob.verifySenderIdentity('p25b-alice@local', alice.identityKey, fetchSwapped)).toBe('unknown');

    // Честный каталог — сессия устанавливается
    const fetchGood = () => Promise.resolve({ ok: true, devices: [bundleOf(alice, 'a1')] });
    const sealed = await bob.encryptForDevices('p25b-alice@local', { kind: 'text', text: 'x' }, fetchGood);
    expect(sealed?.copies.map((c) => c.deviceId)).toEqual(['a1']);
    expect(await bob.verifySenderIdentity('p25b-alice@local', alice.identityKey, fetchGood)).toBe('ok');
  });

  it('в списке устройств подпись обязательна даже без signing_key', async () => {
    const alice = await E2eEngine.create('p25c-alice@local');
    const bob = await E2eEngine.create('p25c-bob@local');
    const stripped = bundleOf(alice, 'a1', { signing_key: '', signed_prekey_sig: '' });
    const fetchStripped = () => Promise.resolve({ ok: true, devices: [stripped] });
    expect(await bob.encryptForDevices('p25c-alice@local', { kind: 'text', text: 'x' }, fetchStripped)).toBeUndefined();
  });
});
