// E2E-шифрование текста (Olm: X3DH + double ratchet) — как Фаза 2 десктопа,
// но на @matrix-org/olm (WASM). Wire-контракт тот же: kind=encrypted
// {ciphertext, ctype, sender_identity}, внутри — JSON {from, content}
// (sealed sender: сервер не знает отправителя). Прекеи — каталог identity.
//
// ВАЖНО: Olm-сессия не может расшифровать старое сообщение повторно (ratchet
// уехал), а веб фулл-синкает историю на каждом старте — поэтому расшифрованное
// кэшируется в localStorage по uuid (аналог parvane-dec-cache десктопа).

import Olm from '@matrix-org/olm';
// Vite отдаёт путь к wasm-файлу как URL
import olmWasmPath from '@matrix-org/olm/olm.wasm?url';

import { SecureE2eStorage } from './secureStorage';

// Только для одноразового чтения старого localStorage при переходе на v2.
// Новый state всегда перепикливается уникальным случайным ключом и затем
// целиком шифруется non-extractable WebCrypto-ключом в IndexedDB.
const LEGACY_COMMON_PICKLE_KEY = 'parvane-web-pickle';
const ONE_TIME_BATCH = 20;
const STORAGE_VERSION = 2;
const LEGACY_STORAGE_PARTS = [
  'account', 'sessions', 'contacts', 'dec', 'gout', 'gin', 'grecip', 'published',
];

function locateOlmWasm() {
  const nodeProcess = (globalThis as {
    process?: { cwd?: () => string; versions?: { node?: string } };
  }).process;
  if (nodeProcess?.versions?.node && nodeProcess.cwd && olmWasmPath.startsWith('/node_modules/')) {
    return `${nodeProcess.cwd()}${olmWasmPath}`;
  }
  return olmWasmPath;
}

type BundleFetcher = (user: string) => Promise<{
  ok: boolean;
  identity_key?: string;
  signed_prekey?: string;
  one_time?: string;
} | undefined>;

type StoredInner = { from: string; content: unknown };

type PersistedE2eState = {
  version: number;
  pickleKey: string;
  account: string;
  sessions: Record<string, string>;
  contacts: Record<string, string>;
  decCache: Record<string, StoredInner>;
  groupOut: Record<string, { pickle: string; epoch: number }>;
  groupIn: Record<string, { pickle: string; epoch: number }>;
  groupRecipients: Record<string, string[]>;
  published: boolean;
};

let isOlmReady = false;

export class E2eEngine {
  private storage!: SecureE2eStorage;

  private pickleKey = '';

  private persistChain = Promise.resolve();

  private storageError: unknown;

  private account!: Olm.Account;

  private sessionsByIdentity = new Map<string, Olm.Session>();

  private identityByContact: Record<string, string> = {};

  private decCache: Record<string, StoredInner> = {};

  // Megolm: своя исходящая group-сессия на группу (+ эпоха для ротации) и
  // входящие сессии от участников, ключ = `${group}|${senderIdentity}`
  private groupOut = new Map<string, { session: Olm.OutboundGroupSession; epoch: number }>();

  private groupIn = new Map<string, { session: Olm.InboundGroupSession; epoch: number }>();

  private groupRecipients = new Map<string, string[]>();

  private self = '';

  private published = false;

  identityKey = '';

  static async create(self: string) {
    if (!isOlmReady) {
      // Emscripten-сборка olm читает глобаль OLM_OPTIONS и падает без неё
      (globalThis as { OLM_OPTIONS?: object }).OLM_OPTIONS = {};
      await Olm.init({ locateFile: locateOlmWasm });
      isOlmReady = true;
    }
    const engine = new E2eEngine();
    engine.self = self;
    engine.storage = await SecureE2eStorage.open(self);
    const state = await engine.storage.load<PersistedE2eState>();
    if (state) {
      engine.loadState(state, state.pickleKey);
    } else {
      engine.loadLegacyState();
    }
    await engine.storage.save(engine.buildState());
    return engine;
  }

  static async clear(self: string) {
    E2eEngine.clearLegacyState(self);
    await SecureE2eStorage.clear(self);
  }

  private static clearLegacyState(self: string) {
    LEGACY_STORAGE_PARTS.forEach((part) => {
      localStorage.removeItem(`parvane:e2e:${self}:${part}`);
    });
  }

  private legacyStorageKey(part: string) {
    return `parvane:e2e:${this.self}:${part}`;
  }

  private loadState(state: PersistedE2eState, pickleKey: string) {
    if (state.version !== STORAGE_VERSION || !pickleKey || !state.account) {
      throw new Error(`Unsupported E2E state version: ${state.version}.`);
    }
    this.pickleKey = pickleKey;
    this.account = new Olm.Account();
    this.account.unpickle(pickleKey, state.account);
    this.identityKey = (JSON.parse(this.account.identity_keys()) as { curve25519: string }).curve25519;

    Object.entries(state.sessions || {}).forEach(([identity, pickle]) => {
      const session = new Olm.Session();
      session.unpickle(pickleKey, pickle);
      this.sessionsByIdentity.set(identity, session);
    });
    this.identityByContact = state.contacts || {};
    this.decCache = state.decCache || {};

    Object.entries(state.groupOut || {}).forEach(([group, { pickle, epoch }]) => {
      const session = new Olm.OutboundGroupSession();
      session.unpickle(pickleKey, pickle);
      this.groupOut.set(group, { session, epoch });
    });
    Object.entries(state.groupIn || {}).forEach(([key, { pickle, epoch }]) => {
      const session = new Olm.InboundGroupSession();
      session.unpickle(pickleKey, pickle);
      this.groupIn.set(key, { session, epoch });
    });
    Object.entries(state.groupRecipients || {}).forEach(([group, recipients]) => {
      this.groupRecipients.set(group, recipients);
    });
    this.published = Boolean(state.published);
  }

  private loadLegacyState() {
    const accountPickle = localStorage.getItem(this.legacyStorageKey('account'));
    this.pickleKey = randomSecret();
    if (!accountPickle) {
      this.account = new Olm.Account();
      this.account.create();
      this.identityKey = (JSON.parse(this.account.identity_keys()) as { curve25519: string }).curve25519;
      E2eEngine.clearLegacyState(this.self);
      return;
    }

    try {
      const legacyState: PersistedE2eState = {
        version: STORAGE_VERSION,
        pickleKey: LEGACY_COMMON_PICKLE_KEY,
        account: accountPickle,
        sessions: this.readLegacyJson('sessions'),
        contacts: this.readLegacyJson('contacts'),
        decCache: this.readLegacyJson('dec'),
        groupOut: this.readLegacyJson('gout'),
        groupIn: this.readLegacyJson('gin'),
        groupRecipients: this.readLegacyJson('grecip'),
        published: localStorage.getItem(this.legacyStorageKey('published')) === '1',
      };
      this.loadState(legacyState, LEGACY_COMMON_PICKLE_KEY);
      this.pickleKey = randomSecret();
    } finally {
      // Включая plaintext decrypted cache и общий-key pickles.
      E2eEngine.clearLegacyState(this.self);
    }
  }

  private readLegacyJson<T>(part: string): T {
    return JSON.parse(localStorage.getItem(this.legacyStorageKey(part)) || '{}') as T;
  }

  private buildState(): PersistedE2eState {
    const sessions: Record<string, string> = {};
    this.sessionsByIdentity.forEach((session, identity) => {
      sessions[identity] = session.pickle(this.pickleKey);
    });
    const groupOut: PersistedE2eState['groupOut'] = {};
    this.groupOut.forEach(({ session, epoch }, group) => {
      groupOut[group] = { pickle: session.pickle(this.pickleKey), epoch };
    });
    const groupIn: PersistedE2eState['groupIn'] = {};
    this.groupIn.forEach(({ session, epoch }, key) => {
      groupIn[key] = { pickle: session.pickle(this.pickleKey), epoch };
    });
    return {
      version: STORAGE_VERSION,
      pickleKey: this.pickleKey,
      account: this.account.pickle(this.pickleKey),
      sessions,
      contacts: this.identityByContact,
      decCache: this.decCache,
      groupOut,
      groupIn,
      groupRecipients: Object.fromEntries(this.groupRecipients),
      published: this.published,
    };
  }

  private queuePersist() {
    const state = this.buildState();
    this.persistChain = this.persistChain.then(async () => {
      try {
        await this.storage.save(state);
      } catch (err) {
        this.storageError = err;
      }
    });
  }

  async flushStorage() {
    await this.persistChain;
    if (this.storageError) {
      throw this.storageError instanceof Error
        ? this.storageError
        : new Error('Unknown E2E storage failure.');
    }
  }

  private persistAccount() {
    this.queuePersist();
  }

  private persistSessions() {
    this.queuePersist();
  }

  private persistContacts() {
    this.queuePersist();
  }

  private persistDecCache() {
    this.queuePersist();
  }

  // Пачка публичных прекеев для identity-шарда. Публикуем ОДИН РАЗ на аккаунт:
  // повторный generate_one_time_keys+mark_keys_as_published каждый логин
  // приводил к рассинхрону OTK (BAD_MESSAGE_KEY_ID у получателя). Ключей на
  // аккаунт (fallback + 20 one-time) хватает; израсходование one-time не делает
  // сессию невозможной (X3DH-фолбэк на fallback-ключ).
  buildPrekeysPayload(token: string): Record<string, unknown> | undefined {
    if (this.published) return undefined;

    this.account.generate_fallback_key();
    const fallback = JSON.parse(this.account.fallback_key()) as { curve25519: Record<string, string> };
    const fallbackKey = Object.values(fallback.curve25519)[0];

    this.account.generate_one_time_keys(ONE_TIME_BATCH);
    const oneTime = JSON.parse(this.account.one_time_keys()) as { curve25519: Record<string, string> };
    let counter = 1;
    const one_time = Object.values(oneTime.curve25519).map((publicKey) => ({
      key_id: counter++,
      public_key: publicKey,
    }));
    this.account.mark_keys_as_published();
    this.published = true;
    this.persistAccount();

    return {
      token,
      registration_id: 1,
      identity_key: this.identityKey,
      signed_prekey_id: 1,
      signed_prekey: fallbackKey,
      signed_prekey_sig: this.account.sign(fallbackKey),
      one_time,
    };
  }

  getCachedInner(uuid: string): StoredInner | undefined {
    return this.decCache[uuid];
  }

  cacheInner(uuid: string, inner: StoredInner) {
    this.decCache[uuid] = inner;
    this.persistDecCache();
  }

  // Шифрует inner-JSON для контакта; undefined — E2E недоступен (нет бандла)
  async encryptFor(contact: string, innerJson: string, fetchBundle: BundleFetcher) {
    let identity = this.identityByContact[contact];
    let session = identity ? this.sessionsByIdentity.get(identity) : undefined;

    if (!session) {
      const bundle = await fetchBundle(contact);
      if (!bundle?.ok || !bundle.identity_key) return undefined;
      const oneTimeKey = bundle.one_time || bundle.signed_prekey;
      if (!oneTimeKey) return undefined;

      identity = bundle.identity_key;
      session = new Olm.Session();
      session.create_outbound(this.account, identity, oneTimeKey);
      this.sessionsByIdentity.set(identity, session);
      this.identityByContact[contact] = identity;
      this.persistAccount();
      this.persistContacts();
    }

    const encrypted = session.encrypt(innerJson) as { type: number; body: string };
    this.persistSessions();
    await this.flushStorage();
    return {
      ciphertext: encrypted.body,
      ctype: encrypted.type,
      sender_identity: this.identityKey,
    };
  }

  // Расшифровка входящего; undefined — не смогли (нет сессии/чужой ratchet)
  decryptFrom(senderIdentity: string, ctype: number, ciphertext: string): string | undefined {
    const existing = this.sessionsByIdentity.get(senderIdentity);
    try {
      if (ctype === 0) {
        // Повторный prekey к уже установленной сессии — расшифровываем ею,
        // НЕ создавая новую (иначе one-time израсходован и inbound падает)
        if (existing && existing.matches_inbound(ciphertext)) {
          const plain = existing.decrypt(ctype, ciphertext);
          this.persistSessions();
          return plain;
        }
        const session = new Olm.Session();
        session.create_inbound_from(this.account, senderIdentity, ciphertext);
        this.account.remove_one_time_keys(session);
        this.persistAccount();
        const plain = session.decrypt(ctype, ciphertext);
        this.sessionsByIdentity.set(senderIdentity, session);
        this.persistSessions();
        return plain;
      }
      if (!existing) return undefined;
      const plain = existing.decrypt(ctype, ciphertext);
      this.persistSessions();
      return plain;
    } catch {
      return undefined;
    }
  }

  rememberContactIdentity(contact: string, identity: string) {
    if (this.identityByContact[contact] === identity) return;
    this.identityByContact[contact] = identity;
    this.persistContacts();
  }

  // ── Megolm (группы) ──────────────────────────────────────────────────────

  private persistGroupOut() {
    this.queuePersist();
  }

  private persistGroupIn() {
    this.queuePersist();
  }

  private persistGroupRecipients() {
    this.queuePersist();
  }

  syncGroupRecipients(group: string, members: string[], self: string) {
    const recipients = Array.from(new Set(members))
      .filter((member) => member && member !== self)
      .sort();
    const previous = this.groupRecipients.get(group);
    const excludesKnownRecipient = previous?.some((member) => !recipients.includes(member)) || false;
    const needsSafeMigration = previous === undefined && this.groupOut.has(group);
    const rotated = excludesKnownRecipient || needsSafeMigration;
    if (rotated) this.rotateGroup(group);
    this.groupRecipients.set(group, recipients);
    this.persistGroupRecipients();
    return rotated;
  }

  // SKDM для раздачи участникам: session_key исходящей + эпоха. Экспорт ключа
  // делается на index 0 ДО первого encrypt (иначе получатель не расшифрует ранние)
  getGroupSessionKey(group: string) {
    let entry = this.groupOut.get(group);
    if (!entry) {
      const session = new Olm.OutboundGroupSession();
      session.create();
      entry = { session, epoch: Date.now() };
      this.groupOut.set(group, entry);
      this.persistGroupOut();
    }
    return { sessionKey: entry.session.session_key(), epoch: entry.epoch };
  }

  async groupEncrypt(group: string, plaintext: string, expectedEpoch?: number) {
    const entry = this.groupOut.get(group);
    if (!entry || (expectedEpoch !== undefined && entry.epoch !== expectedEpoch)) return undefined;
    const ciphertext = entry.session.encrypt(plaintext);
    this.persistGroupOut();
    await this.flushStorage();
    return ciphertext;
  }

  // Ротация после исключения участника: сразу создаём свежую исходящую сессию
  // со строго большей эпохой. Это также закрывает совпадение Date.now() при двух
  // membership changes в одной миллисекунде.
  rotateGroup(group: string) {
    const previous = this.groupOut.get(group);
    const session = new Olm.OutboundGroupSession();
    session.create();
    const epoch = Math.max(Date.now(), (previous?.epoch || 0) + 1);
    previous?.session.free();
    this.groupOut.set(group, { session, epoch });
    this.persistGroupOut();
  }

  // Приём SKDM: принимаем ключ только строго новее известной эпохи (дедуп той
  // же, анти-откат старой, замена на ротацию)
  acceptGroupKey(group: string, senderIdentity: string, sessionKey: string, epoch: number) {
    const key = `${group}|${senderIdentity}`;
    const existing = this.groupIn.get(key);
    if (existing && epoch <= existing.epoch) return;
    try {
      const session = new Olm.InboundGroupSession();
      session.create(sessionKey);
      this.groupIn.set(key, { session, epoch });
      this.persistGroupIn();
    } catch {
      // битый ключ — игнор
    }
  }

  groupDecrypt(group: string, senderIdentity: string, ciphertext: string): string | undefined {
    const entry = this.groupIn.get(`${group}|${senderIdentity}`);
    if (!entry) return undefined;
    try {
      const { plaintext } = entry.session.decrypt(ciphertext);
      this.persistGroupIn();
      return plaintext;
    } catch {
      return undefined;
    }
  }
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
