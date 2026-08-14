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

export type WireDeviceBundle = {
  device_id: string;
  signing_key?: string;
  identity_key: string;
  signed_prekey?: string;
  one_time?: string;
};

type BundleFetcher = (user: string) => Promise<{
  ok: boolean;
  identity_key?: string;
  signed_prekey?: string;
  one_time?: string;
  devices?: WireDeviceBundle[];
} | undefined>;

export type DeviceCiphertext = {
  deviceId: string;
  // Ed25519 ЦЕЛЕВОГО устройства: им помечаются self-копии, чтобы то устройство
  // забрало их своим подписанным sync
  deviceSigningKey: string;
  ciphertext: string;
  ctype: number;
};

type StoredInner = { from: string; content: unknown };

type ContactDevice = { identity: string; signing: string };

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
  // Мультидевайс (опциональны для обратной совместимости снапшотов/бэкапов):
  // id этого устройства ('' — legacy-primary) и известные устройства контактов
  deviceId?: string;
  contactDevices?: Record<string, Record<string, ContactDevice>>;
};

// Как часто перепроверять список устройств контакта перед отправкой (обнаружение
// новых устройств). Известные устройства не расходуют one-time при fetch
const DEVICE_LIST_TTL_MS = 15000;

let isOlmReady = false;

// Живые движки по пользователю: pagehide-хук страхует несохранённые снапшоты
// (очередь персиста асинхронная — закрытие вкладки могло терять хвост)
const enginesBySelf = new Map<string, E2eEngine>();
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    enginesBySelf.forEach((engine) => engine.persistNow());
  });
}

export class E2eEngine {
  private storage!: SecureE2eStorage;

  private pickleKey = '';

  private persistChain = Promise.resolve();

  private storageError: unknown;

  private account!: Olm.Account;

  private sessionsByIdentity = new Map<string, Olm.Session>();

  private identityByContact: Record<string, string> = {};

  // Мультидевайс: contact → deviceId → {identity, signing}. Sessions остаются
  // keyed по identity (он уникален на устройство)
  private devicesByContact = new Map<string, Record<string, ContactDevice>>();

  // Когда список устройств контакта запрашивался в последний раз (не персистится)
  private deviceListFetchedAt = new Map<string, number>();

  private decCache: Record<string, StoredInner> = {};

  // Megolm: своя исходящая group-сессия на группу (+ эпоха для ротации) и
  // входящие сессии от участников, ключ = `${group}|${senderIdentity}`
  private groupOut = new Map<string, { session: Olm.OutboundGroupSession; epoch: number }>();

  private groupIn = new Map<string, { session: Olm.InboundGroupSession; epoch: number }>();

  private groupRecipients = new Map<string, string[]>();

  private self = '';

  private published = false;

  identityKey = '';

  signingKey = '';

  // '' — legacy-primary (прежние установки и desktop); новые установки получают
  // uuid при создании аккаунта. Персистится вместе с состоянием (и в бэкапе)
  deviceId = '';

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
    enginesBySelf.set(self, engine);
    return engine;
  }

  static async clear(self: string) {
    enginesBySelf.delete(self);
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
    this.loadIdentityKeys();

    Object.entries(state.sessions || {}).forEach(([identity, pickle]) => {
      const session = new Olm.Session();
      session.unpickle(pickleKey, pickle);
      this.sessionsByIdentity.set(identity, session);
    });
    this.identityByContact = state.contacts || {};
    this.decCache = state.decCache || {};
    this.deviceId = state.deviceId ?? '';
    Object.entries(state.contactDevices || {}).forEach(([contact, devices]) => {
      this.devicesByContact.set(contact, devices);
    });
    // Миграция до-мультидевайсного снапшота: единственная известная identity
    // контакта — его legacy-primary устройство ''
    Object.entries(this.identityByContact).forEach(([contact, identity]) => {
      if (!this.devicesByContact.has(contact)) {
        this.devicesByContact.set(contact, { '': { identity, signing: '' } });
      }
    });

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
      // Совсем новая установка: свой Olm-аккаунт и свой device_id — не
      // перетирает ключи других устройств этого пользователя на сервере
      this.account = new Olm.Account();
      this.account.create();
      this.loadIdentityKeys();
      this.deviceId = crypto.randomUUID();
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
      deviceId: this.deviceId,
      contactDevices: Object.fromEntries(this.devicesByContact),
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
      device_id: this.deviceId,
      signing_key: this.signingKey,
      registration_id: 1,
      identity_key: this.identityKey,
      signed_prekey_id: 1,
      signed_prekey: fallbackKey,
      signed_prekey_sig: this.account.sign(fallbackKey),
      one_time,
    };
  }

  signCallData(data: string) {
    return this.account.sign(data);
  }

  verifyCallData(publicKey: string, data: string, signature: string) {
    const utility = new Olm.Utility();
    try {
      utility.ed25519_verify(stripBase64Padding(publicKey), data, stripBase64Padding(signature));
      return true;
    } catch {
      return false;
    } finally {
      utility.free();
    }
  }

  getCachedInner(uuid: string): StoredInner | undefined {
    return this.decCache[uuid];
  }

  // Точка атомарного персиста расшифровки: снапшот включает и продвинутый
  // ратчет (`decryptFrom` сам не персистит), и расшифрованный inner
  cacheInner(uuid: string, inner: StoredInner) {
    this.decCache[uuid] = inner;
    this.persistDecCache();
  }

  persistNow() {
    this.queuePersist();
  }

  // ── C1: перенос ключей на другое устройство ────────────────────────────────
  // Экспорт полного состояния (аккаунт, сессии, decCache, группы) под паролем:
  // PBKDF2-SHA256 → AES-GCM. Импорт на новом устройстве делает старую
  // sealed-историю читаемой (decCache) и сохраняет identity

  async exportEncrypted(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveExportKey(password, salt);
    const plaintext = encoder.encode(JSON.stringify(this.buildState()));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toStandaloneBuffer(iv) }, key, toStandaloneBuffer(plaintext),
    );
    return JSON.stringify({
      v: EXPORT_VERSION,
      kdf: 'pbkdf2-sha256',
      iterations: EXPORT_KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(ciphertext)),
    });
  }

  static async importEncrypted(self: string, payload: string, password: string): Promise<E2eEngine> {
    const parsed = JSON.parse(payload) as {
      v: number; iterations?: number; salt: string; iv: string; data: string;
    };
    if (parsed.v !== EXPORT_VERSION) throw new Error(`Unsupported key backup version: ${parsed.v}.`);
    const key = await deriveExportKey(password, base64ToBytes(parsed.salt), parsed.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toStandaloneBuffer(base64ToBytes(parsed.iv)) },
      key,
      toStandaloneBuffer(base64ToBytes(parsed.data)),
    );
    const state = JSON.parse(new TextDecoder().decode(plaintext)) as PersistedE2eState;

    const engine = new E2eEngine();
    engine.self = self;
    engine.storage = await SecureE2eStorage.open(self);
    engine.loadState(state, state.pickleKey);
    await engine.storage.save(engine.buildState());
    enginesBySelf.set(self, engine);
    return engine;
  }

  // ── Мультидевайс: fan-out по устройствам контакта ─────────────────────────

  // Устройства контакта, с которыми уже есть сессии — identity передаётся в
  // prekeys.fetch как known_devices (их one-time не расходуются)
  getKnownDeviceIds(contact: string): string[] {
    const devices = this.devicesByContact.get(contact) || {};
    const known = Object.entries(devices)
      .filter(([, device]) => this.sessionsByIdentity.has(device.identity))
      .map(([deviceId]) => deviceId);
    // Своё текущее устройство «известно» всегда — иначе каждый fetch самого
    // себя расходовал бы собственную one-time
    if (contact === this.self && !known.includes(this.deviceId)) known.push(this.deviceId);
    return known;
  }

  // Обновить список устройств контакта и установить сессии с новыми.
  // Сетевая ошибка не фатальна — работаем с известными устройствами
  private async refreshContactDevices(contact: string, fetchBundle: BundleFetcher) {
    const now = Date.now();
    const fetchedAt = this.deviceListFetchedAt.get(contact) || 0;
    if (this.devicesByContact.has(contact) && now - fetchedAt < DEVICE_LIST_TTL_MS) return;

    let bundle: Awaited<ReturnType<BundleFetcher>>;
    try {
      bundle = await fetchBundle(contact);
    } catch {
      return;
    }
    if (!bundle?.ok) return;
    const devices: WireDeviceBundle[] = bundle.devices?.length ? bundle.devices : (
      // Legacy identity без списка устройств — считаем его primary ('')
      bundle.identity_key ? [{
        device_id: '',
        identity_key: bundle.identity_key,
        signed_prekey: bundle.signed_prekey,
        one_time: bundle.one_time,
      }] : []
    );
    if (!devices.length) return;

    const next: Record<string, ContactDevice> = {};
    let accountChanged = false;
    devices.forEach((device) => {
      // Своё текущее устройство в списке самого себя — сессия не нужна
      if (!device.identity_key || device.identity_key === this.identityKey) return;
      next[device.device_id] = { identity: device.identity_key, signing: device.signing_key || '' };
      if (this.sessionsByIdentity.has(device.identity_key)) return;
      const oneTimeKey = device.one_time || device.signed_prekey;
      if (!oneTimeKey) return;
      const session = new Olm.Session();
      session.create_outbound(this.account, device.identity_key, oneTimeKey);
      this.sessionsByIdentity.set(device.identity_key, session);
      accountChanged = true;
    });
    this.devicesByContact.set(contact, next);
    this.deviceListFetchedAt.set(contact, now);
    if (!Object.keys(next).length) return;
    const primary = devices.find((device) => device.device_id === '') || devices[0];
    if (primary.identity_key !== this.identityKey) {
      this.identityByContact[contact] = primary.identity_key;
    }
    if (accountChanged) this.persistAccount();
    this.persistContacts();
  }

  // Шифрует inner-JSON для ВСЕХ устройств контакта (мультидевайс). undefined —
  // E2E недоступен (нет ни одного устройства с рабочей сессией).
  // `skipDeviceId` — не шифровать для этого устройства (своё текущее при
  // fan-out самому себе). Частичное покрытие (часть устройств без сессии) —
  // не ошибка: копии получают те, до кого дотянулись
  async encryptForDevices(
    contact: string,
    innerJson: string,
    fetchBundle: BundleFetcher,
    skipDeviceId?: string,
  ): Promise<{ copies: DeviceCiphertext[]; senderIdentity: string } | undefined> {
    await this.refreshContactDevices(contact, fetchBundle);
    const devices = this.devicesByContact.get(contact);
    if (!devices) return undefined;

    const copies: DeviceCiphertext[] = [];
    Object.entries(devices).forEach(([deviceId, device]) => {
      if (skipDeviceId !== undefined && deviceId === skipDeviceId) return;
      const session = this.sessionsByIdentity.get(device.identity);
      if (!session) return;
      const encrypted = session.encrypt(innerJson) as { type: number; body: string };
      copies.push({
        deviceId, deviceSigningKey: device.signing, ciphertext: encrypted.body, ctype: encrypted.type,
      });
    });
    if (!copies.length) return undefined;
    this.persistSessions();
    await this.flushStorage();
    return { copies, senderIdentity: this.identityKey };
  }

  // Расшифровка входящего; undefined — не смогли (нет сессии/чужой ratchet).
  // НАМЕРЕННО не персистит: продвинутый ратчет уходит на диск только вместе с
  // записью decCache (`cacheInner`, тот же тик). Иначе резкий kill между двумя
  // снапшотами оставлял на диске уехавший ратчет БЕЗ расшифрованного inner —
  // сообщение становилось нечитаемым навсегда. Без персиста ратчет на диске
  // отстаёт, и после рестарта то же sealed расшифровывается заново
  decryptFrom(senderIdentity: string, ctype: number, ciphertext: string): string | undefined {
    const existing = this.sessionsByIdentity.get(senderIdentity);
    try {
      if (ctype === 0) {
        // Повторный prekey к уже установленной сессии — расшифровываем ею,
        // НЕ создавая новую (иначе one-time израсходован и inbound падает)
        if (existing && existing.matches_inbound(ciphertext)) {
          return existing.decrypt(ctype, ciphertext);
        }
        const session = new Olm.Session();
        session.create_inbound_from(this.account, senderIdentity, ciphertext);
        this.account.remove_one_time_keys(session);
        const plain = session.decrypt(ctype, ciphertext);
        this.sessionsByIdentity.set(senderIdentity, session);
        return plain;
      }
      if (!existing) return undefined;
      return existing.decrypt(ctype, ciphertext);
    } catch {
      return undefined;
    }
  }

  rememberContactIdentity(contact: string, identity: string) {
    if (this.identityByContact[contact] === identity) return;
    this.identityByContact[contact] = identity;
    this.persistContacts();
  }

  private loadIdentityKeys() {
    const keys = JSON.parse(this.account.identity_keys()) as { curve25519: string; ed25519: string };
    this.identityKey = keys.curve25519;
    this.signingKey = keys.ed25519;
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

function stripBase64Padding(value: string) {
  return value.replace(/=+$/, '');
}

const EXPORT_VERSION = 1;
const EXPORT_KDF_ITERATIONS = 310000;

// WebCrypto требует BufferSource с обычным ArrayBuffer
function toStandaloneBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveExportKey(password: string, salt: Uint8Array, iterations = EXPORT_KDF_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw', toStandaloneBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2', hash: 'SHA-256', salt: toStandaloneBuffer(salt), iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
