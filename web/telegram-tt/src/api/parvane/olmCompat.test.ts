import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { E2eEngine } from './e2e';
import fixture from './e2eLibolmFixture.json';
import {
  createAccount, createInboundGroup, createInboundSession, createOutboundGroup, decryptGroup, encryptOlm,
  importInboundGroup, loadOlm, unpickleAccount, unpickleInboundGroup, unpickleOutboundGroup, unpickleSession,
  verifyEd25519,
} from './olmCompat';
import { SecureE2eStorage } from './secureStorage';

// T056/T057 (P-36): libolm убран, криптография v1 — движок (vodozemac в WASM).
// Фикстура `e2eLibolmFixture.json` снята НАСТОЯЩИМ libolm (@matrix-org/olm
// 3.2.15) до его удаления: pickle аккаунтов, пары Olm-сессий, Megolm и
// шифртексты с известным открытым текстом. Здесь — что состояние прежних
// версий читается, сессии продолжаются и пересохраняются в новом формате.
const KEY = fixture.pickleKey;
const NEW_FORMAT = 'vz1:';
const { alice, bob, carol, old, olm, megolm } = fixture;

const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

beforeAll(async () => {
  await loadOlm();
});

describe('импорт libolm-pickle из фикстуры', () => {
  it('аккаунт: ключи, подпись бит-в-бит, пересохранение в новом формате', () => {
    const account = unpickleAccount(alice.account, KEY);
    expect(account.identityKey()).toBe(alice.identityKey);
    expect(account.signingKey()).toBe(alice.signingKey);
    // Ed25519 детерминирован: подпись нового слоя совпадает с подписью libolm
    expect(account.sign(alice.signed.message)).toBe(alice.signed.signature);
    expect(verifyEd25519(alice.signingKey, alice.signed.message, alice.signed.signature)).toBe(true);
    expect(verifyEd25519(alice.signingKey, `${alice.signed.message}!`, alice.signed.signature)).toBe(false);
    expect(verifyEd25519(bob.signingKey, bob.fallbackKey, bob.fallbackKeySignature)).toBe(true);

    expect(() => unpickleAccount(alice.account, 'wrong key')).toThrow();

    const repickled = account.pickle(KEY);
    expect(repickled.startsWith(NEW_FORMAT)).toBe(true);
    expect(() => unpickleAccount(repickled, 'wrong key')).toThrow();
    const restored = unpickleAccount(repickled, KEY);
    expect(restored.identityKey()).toBe(alice.identityKey);
    expect(restored.sign(alice.signed.message)).toBe(alice.signed.signature);

    // Переносимая копия ключей остаётся libolm-pickle (её читают desktop/android)
    const portable = account.toLibolmPickle(KEY);
    expect(portable.startsWith(NEW_FORMAT)).toBe(false);
    expect(unpickleAccount(portable, KEY).signingKey()).toBe(alice.signingKey);
  });

  it('аккаунт под общим ключом старого localStorage', () => {
    const account = unpickleAccount(alice.accountUnderLegacyCommonKey, fixture.legacyCommonKey);
    expect(account.identityKey()).toBe(alice.identityKey);
  });

  it('pre-key сообщение: входящая сессия из импортированного аккаунта, ответ читает вторая сторона', () => {
    const account = unpickleAccount(bob.accountBeforeInbound, KEY);
    expect(account.identityKey()).toBe(bob.identityKey);

    const { session, plaintext } = createInboundSession(account, alice.identityKey, olm.prekey.body);
    expect(plaintext).toBe(olm.prekey.plaintext);
    expect(session.sessionId()).toBe(olm.aliceSessionId);
    // Повторный pre-key той же сессии расшифровывается ею же, без новой входящей
    expect(session.matchesInbound(olm.prekeyRepeat.body)).toBe(true);
    expect(session.matchesInbound(olm.fallbackPrekey.body)).toBe(false);
    expect(session.decrypt(olm.prekeyRepeat.type, olm.prekeyRepeat.body)).toBe(olm.prekeyRepeat.plaintext);
    // One-time ключ израсходован: вторая входящая из того же сообщения невозможна
    expect(() => createInboundSession(account, alice.identityKey, olm.prekey.body)).toThrow();

    const reply = encryptOlm(session, 'ответ из нового слоя');
    expect(reply.type).toBe(1);
    const aliceSession = unpickleSession(olm.aliceSessionAfterPrekeys, KEY);
    expect(aliceSession.decrypt(reply.type, reply.body)).toBe('ответ из нового слоя');

    // Fallback-ключ из импортированного аккаунта принимает pre-key и не расходуется
    const viaFallback = createInboundSession(account, carol.identityKey, olm.fallbackPrekey.body);
    expect(viaFallback.plaintext).toBe(olm.fallbackPrekey.plaintext);
    expect(createInboundSession(account, carol.identityKey, olm.fallbackPrekey.body).plaintext)
      .toBe(olm.fallbackPrekey.plaintext);
  });

  it('Olm-сессии: сообщения в полёте, продолжение ратчета, пересохранение', () => {
    let aliceSession = unpickleSession(olm.aliceSession, KEY);
    let bobSession = unpickleSession(olm.bobSession, KEY);
    expect(aliceSession.sessionId()).toBe(olm.aliceSessionId);
    expect(bobSession.sessionId()).toBe(olm.aliceSessionId);
    expect(() => unpickleSession(olm.aliceSession, 'wrong key')).toThrow();

    expect(bobSession.decrypt(olm.pendingToBob.type, olm.pendingToBob.body)).toBe(olm.pendingToBob.plaintext);
    expect(aliceSession.decrypt(olm.pendingToAlice.type, olm.pendingToAlice.body)).toBe(olm.pendingToAlice.plaintext);

    const fromBob = encryptOlm(bobSession, 'bob продолжает');
    expect(fromBob.type).toBe(1);
    expect(aliceSession.decrypt(fromBob.type, fromBob.body)).toBe('bob продолжает');
    const fromAlice = encryptOlm(aliceSession, 'alice продолжает');
    expect(bobSession.decrypt(fromAlice.type, fromAlice.body)).toBe('alice продолжает');

    const alicePickle = aliceSession.pickle(KEY);
    const bobPickle = bobSession.pickle(KEY);
    expect(alicePickle.startsWith(NEW_FORMAT) && bobPickle.startsWith(NEW_FORMAT)).toBe(true);
    aliceSession = unpickleSession(alicePickle, KEY);
    bobSession = unpickleSession(bobPickle, KEY);
    const again = encryptOlm(aliceSession, 'после пересохранения');
    expect(bobSession.decrypt(again.type, again.body)).toBe('после пересохранения');
    const back = encryptOlm(bobSession, 'и обратно');
    expect(aliceSession.decrypt(back.type, back.body)).toBe('и обратно');
  });

  it('входящая Megolm: старые и новые индексы, экспорт совпадает с libolm', () => {
    const group = megolm.bobGroup;
    let inbound = unpickleInboundGroup(group.inbound, KEY);
    expect(inbound.sessionId()).toBe(group.sessionId);
    expect(inbound.firstKnownIndex()).toBe(0);
    group.messages.forEach(({ ciphertext, plaintext, index }) => {
      expect(decryptGroup(inbound, ciphertext)).toEqual({ plaintext, messageIndex: index });
    });
    expect(inbound.exportSession(1)).toBe(group.exportedAt1);
    expect(inbound.exportSession(inbound.firstKnownIndex())).toBe(group.exportedAtFirst);

    const pickle = inbound.pickle(KEY);
    expect(pickle.startsWith(NEW_FORMAT)).toBe(true);
    inbound = unpickleInboundGroup(pickle, KEY);
    expect(decryptGroup(inbound, group.messages[0].ciphertext).plaintext).toBe(group.messages[0].plaintext);

    // Экспорт libolm с индекса 1: читает с 1, более раннее — нет
    const late = importInboundGroup(group.exportedAt1);
    expect(late.firstKnownIndex()).toBe(1);
    expect(decryptGroup(late, group.messages[3].ciphertext).plaintext).toBe(group.messages[3].plaintext);
    expect(() => decryptGroup(late, group.messages[0].ciphertext)).toThrow();
    // Ключ сессии (SKDM) libolm с индекса 4 — прежние сообщения недоступны
    const fromKey = createInboundGroup(group.sessionKeyAt4);
    expect(fromKey.sessionId()).toBe(group.sessionId);
    expect(() => decryptGroup(fromKey, group.messages[3].ciphertext)).toThrow();
  });

  it('исходящая Megolm импортируется и продолжает с того же индекса', () => {
    const group = megolm.aliceGroup;
    let outbound = unpickleOutboundGroup(group.outbound, KEY);
    expect(outbound.sessionId()).toBe(group.sessionId);
    expect(outbound.messageIndex()).toBe(group.nextIndex);

    const inbound = createInboundGroup(group.sessionKey);
    group.messages.forEach(({ ciphertext, plaintext, index }) => {
      expect(decryptGroup(inbound, ciphertext)).toEqual({ plaintext, messageIndex: index });
    });
    expect(decryptGroup(inbound, outbound.encrypt('после импорта')))
      .toEqual({ plaintext: 'после импорта', messageIndex: group.nextIndex });

    const pickle = outbound.pickle(KEY);
    expect(pickle.startsWith(NEW_FORMAT)).toBe(true);
    outbound = unpickleOutboundGroup(pickle, KEY);
    expect(decryptGroup(inbound, outbound.encrypt('после пересохранения')))
      .toEqual({ plaintext: 'после пересохранения', messageIndex: group.nextIndex + 1 });
  });

  it('аккаунт прежнего устройства (legacy-подписант) подписывает как раньше', () => {
    const legacy = unpickleAccount(old.account, KEY);
    expect(legacy.signingKey()).toBe(old.signingKey);
    expect(legacy.sign(old.signed.message)).toBe(old.signed.signature);
  });
});

describe('совместимость по проводу: новый слой ↔ новый слой', () => {
  it('Olm: one-time и fallback ключи, pre-key → обычные сообщения', () => {
    const sender = createAccount();
    const receiver = createAccount();
    const fallbackKey = receiver.generateFallbackKey()!;
    const oneTimeKeys = receiver.generateOneTimeKeys(3);
    expect(oneTimeKeys).toHaveLength(3);
    expect(new Set([...oneTimeKeys, fallbackKey]).size).toBe(4);
    // Выданные ключи помечены опубликованными: следующая пачка — только новые
    expect(receiver.generateOneTimeKeys(2).some((key) => oneTimeKeys.includes(key))).toBe(false);
    expect(verifyEd25519(receiver.signingKey(), fallbackKey, receiver.sign(fallbackKey))).toBe(true);

    const outbound = sender.createOutboundSession(receiver.identityKey(), oneTimeKeys[0]);
    const first = encryptOlm(outbound, 'первое');
    const second = encryptOlm(outbound, 'второе');
    expect([first.type, second.type]).toEqual([0, 0]);
    expect(first.body).not.toMatch(/=/);

    const inbound = createInboundSession(receiver, sender.identityKey(), first.body);
    expect(inbound.plaintext).toBe('первое');
    expect(inbound.session.sessionId()).toBe(outbound.sessionId());
    expect(inbound.session.matchesInbound(second.body)).toBe(true);
    expect(inbound.session.decrypt(second.type, second.body)).toBe('второе');
    expect(() => createInboundSession(receiver, sender.identityKey(), first.body)).toThrow();

    const reply = encryptOlm(inbound.session, 'ответ');
    expect(outbound.decrypt(reply.type, reply.body)).toBe('ответ');
    const third = encryptOlm(outbound, 'третье');
    expect(third.type).toBe(1);
    expect(inbound.session.decrypt(third.type, third.body)).toBe('третье');
    // Повтор и мусор отвергаются
    expect(() => inbound.session.decrypt(third.type, third.body)).toThrow();
    expect(() => inbound.session.decrypt(1, 'AAAA')).toThrow();
    // Pre-key с чужим identity-ключом отправителя не принимается
    const stranger = createAccount().createOutboundSession(receiver.identityKey(), oneTimeKeys[1]);
    expect(() => createInboundSession(receiver, sender.identityKey(), encryptOlm(stranger, 'чужой').body)).toThrow();
  });

  it('Olm: pre-key по fallback-ключу принимается после его перегенерации', () => {
    const sender = createAccount();
    const receiver = createAccount();
    const fallbackKey = receiver.generateFallbackKey()!;
    const outbound = sender.createOutboundSession(receiver.identityKey(), fallbackKey);
    const hello = encryptOlm(outbound, 'через fallback');
    expect(receiver.generateFallbackKey()).not.toBe(fallbackKey);
    const restored = unpickleAccount(receiver.pickle('k'), 'k');
    expect(createInboundSession(restored, sender.identityKey(), hello.body).plaintext).toBe('через fallback');
    expect(() => sender.createOutboundSession('not base64!', fallbackKey)).toThrow();
  });

  it('Megolm: ключ сессии, экспорт/импорт с индекса, ротация', () => {
    const outbound = createOutboundGroup();
    const keyAtStart = outbound.sessionKey();
    const inbound = createInboundGroup(keyAtStart);
    expect(inbound.sessionId()).toBe(outbound.sessionId());
    const zero = outbound.encrypt('ноль');
    const one = outbound.encrypt('один');
    expect(outbound.messageIndex()).toBe(2);
    expect(decryptGroup(inbound, one)).toEqual({ plaintext: 'один', messageIndex: 1 });
    expect(decryptGroup(inbound, zero)).toEqual({ plaintext: 'ноль', messageIndex: 0 });

    // Участник, получивший ключ позже, не читает прежние сообщения
    const lateJoiner = createInboundGroup(outbound.sessionKey());
    expect(lateJoiner.firstKnownIndex()).toBe(2);
    expect(() => decryptGroup(lateJoiner, one)).toThrow();
    expect(decryptGroup(lateJoiner, outbound.encrypt('два')).messageIndex).toBe(2);

    const imported = importInboundGroup(inbound.exportSession(1));
    expect(imported.firstKnownIndex()).toBe(1);
    expect(decryptGroup(imported, one).plaintext).toBe('один');
    expect(() => decryptGroup(imported, zero)).toThrow();
    expect(() => imported.exportSession(0)).toThrow();

    const rotated = createOutboundGroup();
    expect(rotated.sessionKey()).not.toBe(keyAtStart);
    expect(() => decryptGroup(inbound, rotated.encrypt('после ротации'))).toThrow();
    expect(() => createInboundGroup('мусор')).toThrow();
  });

  it('Ed25519: base64 с дополнением и без, битые ключ и подпись', () => {
    const account = createAccount();
    const signature = account.sign('данные');
    const key = account.signingKey();
    expect(verifyEd25519(key, 'данные', signature)).toBe(true);
    expect(verifyEd25519(`${key}=`, 'данные', `${signature}==`)).toBe(true);
    expect(verifyEd25519(key, 'другие', signature)).toBe(false);
    expect(verifyEd25519(createAccount().signingKey(), 'данные', signature)).toBe(false);
    expect(verifyEd25519('', 'данные', signature)).toBe(false);
    expect(verifyEd25519(key, 'данные', '')).toBe(false);
    expect(verifyEd25519('***', 'данные', '***')).toBe(false);
  });
});

describe('E2eEngine: состояние прежней версии (libolm) в хранилище', () => {
  const USER = 'mig-alice@local';
  const BOB = 'mig-bob@local';
  const GROUP_IN = `group-in|${bob.identityKey}`;
  const fetchBob = () => Promise.resolve({
    ok: true,
    devices: [{
      device_id: '',
      signing_key: bob.signingKey,
      identity_key: bob.identityKey,
      signed_prekey: bob.fallbackKey,
      signed_prekey_sig: bob.fallbackKeySignature,
      one_time: bob.oneTimeKeys[1],
    }],
  });

  type StoredState = {
    account: string;
    sessions: Record<string, string>;
    groupOut: Record<string, { pickle: string; epoch: number }>;
    groupIn: Record<string, { pickle?: string; exported?: string; epoch: number }>;
    legacyAccounts: string[];
  };

  async function seedState(user: string, state: unknown) {
    const storage = await SecureE2eStorage.open(user);
    await storage.save(state);
  }

  async function readStoredState(user: string) {
    const storage = await SecureE2eStorage.open(user);
    return (await storage.load<StoredState>())!;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('localStorage', testLocalStorage);
    localStorage.clear();
    await Promise.all([USER, 'mig-restore@local', 'mig-old-backup@local'].map((user) => E2eEngine.clear(user)));
  });

  it('ничего не теряет: аккаунт, сессии, группы, подписанты; дальше хранит в новом формате', async () => {
    await seedState(USER, fixture.state);
    let engine = await E2eEngine.create(USER);

    expect(engine.identityKey).toBe(alice.identityKey);
    expect(engine.signingKey).toBe(alice.signingKey);
    expect(engine.deviceId).toBe('dev-alice');
    expect(engine.needsHistoryLink()).toBe(false);
    expect(engine.getCachedInner('uuid-history-1')?.content).toMatchObject({ text: 'old history' });
    expect(engine.signCallData(alice.signed.message)).toBe(alice.signed.signature);
    expect(engine.signExtraSync(old.signed.message)).toEqual([
      { signing_key: old.signingKey, signature: old.signed.signature },
    ]);
    // Аккаунт уже публиковал прекеи: заново не публикуем, пополнение продолжает нумерацию
    expect(engine.buildPrekeysPayload('token')).toBeUndefined();

    // Сообщение, зашифрованное libolm и ещё не прочитанное до обновления
    expect(engine.decryptFrom(bob.identityKey, olm.pendingToAlice.type, olm.pendingToAlice.body))
      .toBe(olm.pendingToAlice.plaintext);
    // Сессия с bob продолжается (обычное сообщение, не новый pre-key) — bob из фикстуры читает
    const bobSession = unpickleSession(olm.bobSession, KEY);
    const innerJson = JSON.stringify({ from: USER, content: { kind: 'text', text: 'после обновления' } });
    const sealed = (await engine.encryptForDevices(BOB, innerJson, fetchBob))!;
    expect(sealed.senderIdentity).toBe(alice.identityKey);
    expect(sealed.copies).toHaveLength(1);
    expect(sealed.copies[0].ctype).toBe(1);
    expect(bobSession.decrypt(olm.pendingToBob.type, olm.pendingToBob.body)).toBe(olm.pendingToBob.plaintext);
    expect(bobSession.decrypt(sealed.copies[0].ctype, sealed.copies[0].ciphertext)).toBe(innerJson);

    // Входящие Megolm: из pickle и из экспорта
    const bobMessages = megolm.bobGroup.messages;
    expect(engine.groupDecrypt('group-in', bob.identityKey, bobMessages[2].ciphertext)).toBe(bobMessages[2].plaintext);
    expect(engine.groupDecrypt('group-in', bob.identityKey, bobMessages[0].ciphertext)).toBe(bobMessages[0].plaintext);
    expect(engine.groupDecrypt('group-exported', bob.identityKey, bobMessages[1].ciphertext))
      .toBe(bobMessages[1].plaintext);
    expect(engine.groupDecrypt('group-exported', bob.identityKey, bobMessages[0].ciphertext)).toBeUndefined();

    // Исходящая Megolm импортирована, а не ротирована: та же эпоха и следующий индекс
    const groupKey = engine.getGroupSessionKey('group-out');
    expect(groupKey.epoch).toBe(fixture.state.groupOut['group-out'].epoch);
    const member = createInboundGroup(megolm.aliceGroup.sessionKey);
    const groupCiphertext = (await engine.groupEncrypt('group-out', 'в группу после обновления', groupKey.epoch))!;
    expect(decryptGroup(member, groupCiphertext)).toEqual({
      plaintext: 'в группу после обновления', messageIndex: megolm.aliceGroup.nextIndex,
    });

    // Состояние пересохранено в новом формате
    await engine.flushStorage();
    const stored = await readStoredState(USER);
    const pickles = [
      stored.account,
      ...Object.values(stored.sessions),
      ...Object.values(stored.groupOut).map((entry) => entry.pickle),
      ...Object.values(stored.groupIn).map((entry) => entry.pickle!),
      ...stored.legacyAccounts,
    ];
    expect(pickles).toHaveLength(6);
    pickles.forEach((pickle) => expect(pickle.startsWith(NEW_FORMAT)).toBe(true));
    expect(JSON.stringify(stored)).not.toContain(fixture.state.account);

    // Рестарт уже с новым форматом: всё продолжается
    engine = await E2eEngine.create(USER);
    expect(engine.identityKey).toBe(alice.identityKey);
    const fromBob = encryptOlm(bobSession, 'bob отвечает после рестарта');
    expect(engine.decryptFrom(bob.identityKey, fromBob.type, fromBob.body)).toBe('bob отвечает после рестарта');
    expect(engine.groupDecrypt('group-in', bob.identityKey, bobMessages[3].ciphertext)).toBe(bobMessages[3].plaintext);
    expect(engine.groupDecrypt('group-exported', bob.identityKey, bobMessages[3].ciphertext))
      .toBe(bobMessages[3].plaintext);
    expect(engine.signExtraSync(old.signed.message)[0].signature).toBe(old.signed.signature);
    const nextCiphertext = (await engine.groupEncrypt('group-out', 'ещё одно', groupKey.epoch))!;
    expect(decryptGroup(member, nextCiphertext).messageIndex).toBe(megolm.aliceGroup.nextIndex + 1);
    const topUp = engine.buildTopUpPrekeysPayload('token')!;
    expect((topUp.one_time as { key_id: number }[])[0].key_id).toBe(fixture.state.oneTimeKeyIdNext);
    expect(verifyEd25519(alice.signingKey, topUp.signed_prekey as string, topUp.signed_prekey_sig as string))
      .toBe(true);
    await engine.flushStorage();
  });

  it('нечитаемые сессии не ломают E2E: исходящая Megolm ротируется, история остаётся', async () => {
    await seedState(USER, {
      ...fixture.state,
      sessions: { [bob.identityKey]: 'AAAAbroken' },
      groupOut: { 'group-out': { pickle: 'AAAAbroken', epoch: fixture.state.groupOut['group-out'].epoch } },
    });
    const engine = await E2eEngine.create(USER);
    expect(engine.identityKey).toBe(alice.identityKey);
    expect(engine.getCachedInner('uuid-history-1')?.content).toMatchObject({ text: 'old history' });
    const bobMessages = megolm.bobGroup.messages;
    expect(engine.groupDecrypt('group-in', bob.identityKey, bobMessages[1].ciphertext)).toBe(bobMessages[1].plaintext);

    // Новая исходящая сессия со строго большей эпохой — получатели примут её ключ
    const rotated = engine.getGroupSessionKey('group-out');
    expect(rotated.epoch).toBeGreaterThan(fixture.state.groupOut['group-out'].epoch);
    expect(createInboundGroup(rotated.sessionKey).sessionId()).not.toBe(megolm.aliceGroup.sessionId);
    // Сессия с bob создаётся заново pre-key сообщением
    const sealed = (await engine.encryptForDevices(BOB, '{}', fetchBob))!;
    expect(sealed.copies[0].ctype).toBe(0);
    await engine.flushStorage();
  });

  it('копия ключей: переносимый формат, восстановление, чтение копии прежней версии', async () => {
    await seedState(USER, fixture.state);
    const engine = await E2eEngine.create(USER);

    // Переносимое состояние: аккаунты — libolm-pickle, входящие группы — экспорт
    const portable = JSON.parse(engine.exportStateJson()) as StoredState & { pickleKey: string };
    expect(portable.account.startsWith(NEW_FORMAT)).toBe(false);
    expect(unpickleAccount(portable.account, portable.pickleKey).signingKey()).toBe(alice.signingKey);
    expect(unpickleAccount(portable.legacyAccounts[0], portable.pickleKey).signingKey()).toBe(old.signingKey);
    expect(portable.groupIn[GROUP_IN].pickle).toBeUndefined();
    expect(importInboundGroup(portable.groupIn[GROUP_IN].exported!).sessionId()).toBe(megolm.bobGroup.sessionId);

    const backup = await engine.exportEncrypted('Backup-Password-1');
    const restored = await E2eEngine.importEncrypted('mig-restore@local', backup, 'Backup-Password-1');
    expect(restored.identityKey).toBe(alice.identityKey);
    expect(restored.signExtraSync(old.signed.message)[0].signature).toBe(old.signed.signature);
    const bobMessages = megolm.bobGroup.messages;
    expect(restored.groupDecrypt('group-in', bob.identityKey, bobMessages[2].ciphertext))
      .toBe(bobMessages[2].plaintext);
    expect(restored.decryptFrom(bob.identityKey, olm.pendingToAlice.type, olm.pendingToAlice.body))
      .toBe(olm.pendingToAlice.plaintext);
    await expect(E2eEngine.importEncrypted('mig-restore@local', backup, 'wrong')).rejects.toThrow();

    // Копия, сделанная прежней версией (все pickle — libolm)
    const oldBackup = await encryptBackup(JSON.stringify(fixture.state), 'Old-Password-1');
    const fromOld = await E2eEngine.importEncrypted('mig-old-backup@local', oldBackup, 'Old-Password-1');
    expect(fromOld.identityKey).toBe(alice.identityKey);
    expect(fromOld.decryptFrom(bob.identityKey, olm.pendingToAlice.type, olm.pendingToAlice.body))
      .toBe(olm.pendingToAlice.plaintext);
    expect(fromOld.groupDecrypt('group-in', bob.identityKey, bobMessages[2].ciphertext))
      .toBe(bobMessages[2].plaintext);
    await fromOld.flushStorage();
    expect((await readStoredState('mig-old-backup@local')).account.startsWith(NEW_FORMAT)).toBe(true);
  });

  it('линковка истории из полного состояния прежней версии', async () => {
    const fresh = await E2eEngine.create(USER);
    expect(fresh.needsHistoryLink()).toBe(true);
    fresh.importLinkedHistory(JSON.stringify(fixture.state));
    const bobMessages = megolm.bobGroup.messages;
    expect(fresh.groupDecrypt('group-in', bob.identityKey, bobMessages[1].ciphertext)).toBe(bobMessages[1].plaintext);
    expect(fresh.getCachedInner('uuid-history-1')?.from).toBe(BOB);
    // Аккаунт старого устройства и его подписанты — только подпись sync
    expect(fresh.identityKey).not.toBe(alice.identityKey);
    expect(fresh.signExtraSync(alice.signed.message)).toEqual([
      { signing_key: alice.signingKey, signature: alice.signed.signature },
      { signing_key: old.signingKey, signature: old.signed.signature },
    ]);
    await fresh.flushStorage();
  });
});

// Конверт копии ключей в формате `exportEncrypted` (PBKDF2-SHA256 → AES-GCM)
async function encryptBackup(stateJson: string, password: string) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 310000;
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2', hash: 'SHA-256', salt, iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(stateJson));
  const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return JSON.stringify({
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  });
}
