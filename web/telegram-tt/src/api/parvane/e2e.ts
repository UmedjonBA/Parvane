// E2E-шифрование v1 (Olm: X3DH + double ratchet, Megolm для групп) — как у
// десктопа. Криптография — движок `parvane-protocol` через `olmCompat.ts`;
// здесь остаётся диалект v1: kind=encrypted {ciphertext, ctype,
// sender_identity}, внутри — JSON {from, content} (sealed sender: сервер не
// знает отправителя). Прекеи — каталог identity.
//
// ВАЖНО: Olm-сессия не может расшифровать старое сообщение повторно (ratchet
// уехал), а веб фулл-синкает историю на каждом старте — поэтому расшифрованное
// кэшируется в localStorage по uuid (аналог parvane-dec-cache десктопа).

import type {
  MegolmInbound, MegolmOutbound, OlmAccount, OlmSession,
} from './olmCompat';

import {
  createAccount, createInboundGroup, createInboundSession, createOutboundGroup, decryptGroup, encryptOlm,
  importInboundGroup, loadOlm, unpickleAccount, unpickleInboundGroup, unpickleOutboundGroup, unpickleSession,
  verifyEd25519,
} from './olmCompat';
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

export type WireDeviceBundle = {
  device_id: string;
  signing_key?: string;
  identity_key: string;
  signed_prekey?: string;
  // P-25: подпись signed_prekey Ed25519-ключом устройства (signing_key);
  // бандл из каталога без валидной подписи не используется
  signed_prekey_sig?: string;
  one_time?: string;
};

// Отпечаток ключа: SHA-256 от base64 identity-ключа, 12 групп по 4 hex-символа
// (48 символов), как safety number — сверяется вслух/по другому каналу
export async function fingerprintOf(key: string): Promise<string> {
  if (!key) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return (hex.slice(0, 48).match(/.{4}/g) || []).join(' ');
}

type BundleFetcher = (user: string) => Promise<{
  ok: boolean;
  signing_key?: string;
  identity_key?: string;
  signed_prekey?: string;
  signed_prekey_sig?: string;
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

// `senderIdentity` — curve25519 устройства-отправителя из sealed-конверта.
// Кэшируется вместе с расшифровкой, чтобы аутентичность отправителя можно было
// перепроверять по каталогу identity и после рестарта (иначе cached-путь
// доверял бы `from` слепо). Для своих исходящих не задаётся
// `ctHash` — отпечаток шифртекста, из которого получен inner: по нему
// решаем, можно ли верить кэшу после правки (см. unsealStored в sync.ts)
type StoredInner = { from: string; content: unknown; senderIdentity?: string; ctHash?: string };

// Вердикт проверки принадлежности sender_identity заявленному отправителю:
// ok — ключ в каталоге отправителя; spoofed — каталог получен, ключа там нет
// (подмена); unknown — каталог недоступен (сеть), подтвердить не удалось
export type SenderVerdict = 'ok' | 'spoofed' | 'unknown';

type ContactDevice = { identity: string; signing: string };

type PersistedE2eState = {
  version: number;
  pickleKey: string;
  account: string;
  sessions: Record<string, string>;
  contacts: Record<string, string>;
  decCache: Record<string, StoredInner>;
  groupOut: Record<string, { pickle: string; epoch: number }>;
  // exported — ключ в формате libolm export_session (переносимый: так пишут
  // desktop и копия ключей); pickle — формат хранилища (см. olmCompat.ts).
  groupIn: Record<string, { pickle?: string; exported?: string; epoch: number }>;
  groupRecipients: Record<string, string[]>;
  published: boolean;
  // Мультидевайс (опциональны для обратной совместимости снапшотов/бэкапов):
  // id этого устройства ('' — legacy-primary) и известные устройства контактов
  deviceId?: string;
  contactDevices?: Record<string, Record<string, ContactDevice>>;
  // Следующий key_id для пополнения one-time prekeys: сервер дедупит по
  // (username, device_id, key_id), повтор старых id был бы тихим no-op
  oneTimeKeyIdNext?: number;
  // Авто-линковка (legacy v1): pickle аккаунтов прежних устройств (под НАШИМ pickleKey) —
  // только для подписи sync (extra_signing), их sealed-исходящие видны и нам.
  // v2 (P-48) приватные аккаунты больше не переезжают — см. transfers.
  legacyAccounts?: string[];
  // v2: подписанные прежними устройствами переносы владения их исходящими
  // (`link-transfer:<user>:<old>:<new>`), отправляются в каждом sync.
  transfers?: { old_signing_key: string; signature: string }[];
  // P-04: УЖЕ ВИДЕННЫЕ identity контактов (TOFU). Каталог их не засевает
  // после первого знакомства — иначе сервер подменил бы ключ без предупреждения.
  seenIdentities?: Record<string, string[]>;
};

// v2-экспорт при линковке (P-48): ТОЛЬКО история и входящие групповые ключи,
// без приватного Olm-аккаунта, Olm-сессий, исходящих Megolm и pickleKey.
export type LinkExportState = {
  linkVersion: 2;
  decCache: PersistedE2eState['decCache'];
  groupIn: Record<string, { exported: string; epoch: number }>;
  contacts: Record<string, string>;
  contactDevices?: Record<string, Record<string, ContactDevice>>;
  groupRecipients?: Record<string, string[]>;
  // подписанные переносы, унаследованные старым устройством от его предков
  transfers?: { old_signing_key: string; signature: string }[];
  seenIdentities?: Record<string, string[]>;
};

// Как часто перепроверять список устройств контакта перед отправкой (обнаружение
// новых устройств). Известные устройства не расходуют one-time при fetch
const DEVICE_LIST_TTL_MS = 15000;

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

  private account!: OlmAccount;

  private sessionsByIdentity = new Map<string, OlmSession>();

  private identityByContact: Record<string, string> = {};
  // P-04: виденные identity по контакту — смена ключа определяется по ним,
  // а не по identityByContact (его перезаписывает каталог до проверки)
  private seenIdentities = new Map<string, Set<string>>();

  // Мультидевайс: contact → deviceId → {identity, signing}. Sessions остаются
  // keyed по identity (он уникален на устройство)
  private devicesByContact = new Map<string, Record<string, ContactDevice>>();

  // Когда список устройств контакта запрашивался в последний раз (не персистится)
  private deviceListFetchedAt = new Map<string, number>();

  private decCache: Record<string, StoredInner> = {};

  // Megolm: своя исходящая group-сессия на группу (+ эпоха для ротации) и
  // входящие сессии от участников, ключ = `${group}|${senderIdentity}`
  private groupOut = new Map<string, { session: MegolmOutbound; epoch: number }>();

  private groupIn = new Map<string, { session: MegolmInbound; epoch: number }>();

  private groupRecipients = new Map<string, string[]>();

  private self = '';

  private published = false;

  private oneTimeKeyIdNext = ONE_TIME_BATCH + 1;

  // Аккаунты прежних устройств (авто-линковка): используются ТОЛЬКО для
  // подписи sync-запросов, никаких сессий/шифрования от их имени
  private legacySigners: OlmAccount[] = [];
  // v2 (P-48): переносы владения исходящими прежних устройств.
  private transfers: { old_signing_key: string; signature: string }[] = [];

  identityKey = '';

  signingKey = '';

  // '' — legacy-primary (прежние установки и desktop); новые установки получают
  // uuid при создании аккаунта. Персистится вместе с состоянием (и в бэкапе)
  deviceId = '';

  private presetDeviceId = '';

  // presetDeviceId — id, уже заявленный в JWT первого входа (claim dev):
  // свежая установка берёт его, а не генерирует свой, иначе отзыв устройства
  // не гасил бы токен первой сессии
  static async create(self: string, presetDeviceId?: string) {
    await loadOlm();
    const engine = new E2eEngine();
    engine.self = self;
    engine.presetDeviceId = presetDeviceId || '';
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
    // Pickle читается в обоих форматах (libolm прежних версий и нынешний);
    // сохраняется состояние уже только в нынешнем (см. buildState)
    this.account = unpickleAccount(state.account, pickleKey);
    this.loadIdentityKeys();

    // Битая сессия не должна лишать пользователя всего E2E: без неё пропадает
    // только ратчет с одним устройством, он пересоздаётся pre-key сообщением
    Object.entries(state.sessions || {}).forEach(([identity, pickle]) => {
      try {
        this.sessionsByIdentity.set(identity, unpickleSession(pickle, pickleKey));
      } catch {
        // Пропускаем
      }
    });
    this.identityByContact = state.contacts || {};
    this.decCache = state.decCache || {};
    this.deviceId = state.deviceId ?? '';
    Object.entries(state.contactDevices || {}).forEach(([contact, devices]) => {
      this.devicesByContact.set(contact, devices);
    });
    if (state.seenIdentities) {
      Object.entries(state.seenIdentities).forEach(([contact, ids]) => {
        this.seenIdentities.set(contact, new Set(ids));
      });
    } else {
      // Миграция снапшота без seenIdentities: всё, что знали до сих пор,
      // считаем виденным — иначе первое же сообщение выглядело бы сменой ключа
      Object.entries(this.identityByContact).forEach(([contact, identity]) => {
        this.markSeen(contact, identity);
      });
      this.devicesByContact.forEach((devices, contact) => {
        Object.values(devices).forEach((device) => this.markSeen(contact, device.identity));
      });
    }
    // Миграция до-мультидевайсного снапшота: единственная известная identity
    // контакта — его legacy-primary устройство ''
    Object.entries(this.identityByContact).forEach(([contact, identity]) => {
      if (!this.devicesByContact.has(contact)) {
        this.devicesByContact.set(contact, { '': { identity, signing: '' } });
      }
    });

    // Исходящая сессия, которую не удалось прочитать, заменяется ротацией:
    // следующая отправка создаст новую с большей эпохой и разошлёт ключ
    Object.entries(state.groupOut || {}).forEach(([group, { pickle, epoch }]) => {
      try {
        this.groupOut.set(group, { session: unpickleOutboundGroup(pickle, pickleKey), epoch });
      } catch {
        // Пропускаем
      }
    });
    Object.entries(state.groupIn || {}).forEach(([key, { pickle, exported, epoch }]) => {
      try {
        if (exported) this.groupIn.set(key, { session: importInboundGroup(exported), epoch });
        else if (pickle) this.groupIn.set(key, { session: unpickleInboundGroup(pickle, pickleKey), epoch });
      } catch {
        // Пропускаем
      }
    });
    Object.entries(state.groupRecipients || {}).forEach(([group, recipients]) => {
      this.groupRecipients.set(group, recipients);
    });
    this.published = Boolean(state.published);
    this.oneTimeKeyIdNext = state.oneTimeKeyIdNext ?? ONE_TIME_BATCH + 1;
    this.transfers = (state.transfers || []).filter((t) => t.old_signing_key && t.signature);
    (state.legacyAccounts || []).forEach((accountPickle) => {
      try {
        this.legacySigners.push(unpickleAccount(accountPickle, pickleKey));
      } catch {
        // битый pickle — теряем только подпись старых исходящих
      }
    });
  }

  private loadLegacyState() {
    const accountPickle = localStorage.getItem(this.legacyStorageKey('account'));
    this.pickleKey = randomSecret();
    if (!accountPickle) {
      // Совсем новая установка: свой Olm-аккаунт и свой device_id — не
      // перетирает ключи других устройств этого пользователя на сервере
      this.account = createAccount();
      this.loadIdentityKeys();
      this.deviceId = this.presetDeviceId || crypto.randomUUID();
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
      oneTimeKeyIdNext: this.oneTimeKeyIdNext,
      legacyAccounts: this.legacySigners.map((legacy) => legacy.pickle(this.pickleKey)),
      transfers: this.transfers,
      seenIdentities: this.seenIdentitiesSnapshot(),
    };
  }

  // Переносимое состояние для копии ключей: приватные аккаунты — libolm-pickle,
  // входящие групповые ключи — экспорт с первого известного индекса; их читают
  // и desktop/android (`parvane-e2e`). Olm-сессии и исходящие Megolm остаются
  // в формате хранилища — они нужны только web при восстановлении
  private buildPortableState(): PersistedE2eState {
    const groupIn: PersistedE2eState['groupIn'] = {};
    this.groupIn.forEach(({ session, epoch }, key) => {
      groupIn[key] = { exported: session.exportSession(session.firstKnownIndex()), epoch };
    });
    return {
      ...this.buildState(),
      account: this.account.toLibolmPickle(this.pickleKey),
      groupIn,
      legacyAccounts: this.legacySigners.map((legacy) => legacy.toLibolmPickle(this.pickleKey)),
    };
  }

  // Коалесценция записи: раньше на КАЖДОЕ сообщение сериализовалось всё
  // состояние (все pickle + весь decCache) и писалось в IDB — O(история) на
  // сообщение, минуты на входе. Теперь dirty-флаг + короткий debounce; при
  // уходе со страницы сбрасываем немедленно (ратчет Olm обязан пережить
  // закрытие вкладки), flushStorage() форсирует запись
  private persistDirty = false;

  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  private queuePersist() {
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flushNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private flushNow() {
    if (!this.persistDirty) return;
    this.persistDirty = false;
    const state = this.buildState();
    this.persistChain = this.persistChain.then(async () => {
      try {
        await this.storage.save(state);
      } catch (err) {
        this.storageError = err;
      }
    });
  }

  flushOnPageHide() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.flushNow();
  }

  async flushStorage() {
    this.flushOnPageHide();
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

    // Оба вызова помечают выданные ключи опубликованными
    const fallbackKey = this.account.generateFallbackKey()!;
    let counter = 1;
    const one_time = this.account.generateOneTimeKeys(ONE_TIME_BATCH).map((publicKey) => ({
      key_id: counter++,
      public_key: publicKey,
    }));
    this.published = true;
    this.oneTimeKeyIdNext = one_time.length + 1;
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

  // Пополнение one-time prekeys, когда серверный остаток просел (X3DH без
  // one-time — деградация PFS первого сообщения). Нумерация key_id продолжается
  // с персистентного счётчика: сервер дедупит по (username, device_id, key_id),
  // и повтор старых id был бы тихим no-op. Fallback-ключ перегенерируется
  // (аккаунт держит и предыдущий — прекей-сообщения в полёте расшифруются)
  buildTopUpPrekeysPayload(token: string): Record<string, unknown> | undefined {
    if (!this.published) return undefined;

    const fallbackKey = this.account.generateFallbackKey();
    const keys = this.account.generateOneTimeKeys(ONE_TIME_BATCH);
    if (!keys.length || !fallbackKey) return undefined;
    const one_time = keys.map((publicKey) => ({
      key_id: this.oneTimeKeyIdNext++,
      public_key: publicKey,
    }));
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
    return verifyEd25519(publicKey, data, signature);
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

  // Снять расшифрованный inner из кэша (TTL-самоуничтожение у получателя):
  // без этого plaintext эфемерного сообщения оставался бы в persisted decCache
  // навсегда и уезжал в экспорт ключей, ломая обещание «исчезает после срока»
  dropCachedInner(uuid: string) {
    if (!(uuid in this.decCache)) return;
    delete this.decCache[uuid];
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
    const plaintext = encoder.encode(JSON.stringify(this.buildPortableState()));
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

  // ── Авто-линковка: передача истории между живыми устройствами ─────────────
  // Экспорт — полный снапшот (как ручной бэкап), но импорт при линковке
  // СЛИВАЕТ только читающий материал: decCache (расшифрованная история) и
  // входящие Megolm-сессии. Собственные identity/Olm-сессии/deviceId остаются
  // нетронутыми — полная замена раздвоила бы один Olm-ратчет между двумя
  // живыми устройствами (в отличие от ручного импорта, который — миграция).
  // Шифрование здесь НЕ делается — транспорт (linking.ts) заворачивает JSON
  // в ECDH-бокс + cloud-шифртекст

  exportStateJson(): string {
    return JSON.stringify(this.buildPortableState());
  }

  // v2 (P-48): экспорт для линковки БЕЗ приватного материала — новое устройство
  // остаётся самостоятельным (свой Olm-аккаунт и сессии); ему передаём только
  // историю, входящие групповые ключи (экспорт на текущем индексе), каталоги и
  // уже накопленные переносы владения.
  exportLinkStateJson(): string {
    const groupIn: LinkExportState['groupIn'] = {};
    this.groupIn.forEach(({ session, epoch }, key) => {
      try {
        groupIn[key] = { exported: session.exportSession(session.firstKnownIndex()), epoch };
      } catch {
        // сессию без экспорта пропускаем
      }
    });
    const state: LinkExportState = {
      linkVersion: 2,
      decCache: this.decCache,
      groupIn,
      contacts: this.identityByContact,
      contactDevices: Object.fromEntries(this.devicesByContact),
      groupRecipients: Object.fromEntries(this.groupRecipients),
      transfers: this.transfers,
      seenIdentities: this.seenIdentitiesSnapshot(),
    };
    return JSON.stringify(state);
  }

  // v2 (P-48): старое устройство подписывает перенос владения своими исходящими
  // конкретному новому устройству; приватный ключ никуда не уезжает.
  signLinkTransfer(self: string, newSigningKey: string): { old_signing_key: string; signature: string } {
    const statement = `link-transfer:${self}:${this.signingKey}:${newSigningKey}`;
    return { old_signing_key: this.signingKey, signature: this.account.sign(statement) };
  }

  // Переносы владения для sync (transfers) — сервер отдаёт исходящие прежних
  // устройств только по валидной подписи над `link-transfer:<user>:<old>:<new>`.
  syncTransfers(): { old_signing_key: string; signature: string }[] {
    return this.transfers;
  }

  private addTransfer(transfer: { old_signing_key: string; signature: string } | undefined) {
    if (!transfer || !transfer.old_signing_key || !transfer.signature) return;
    if (transfer.old_signing_key === this.signingKey) return;
    if (this.transfers.some((t) => t.old_signing_key === transfer.old_signing_key)) return;
    this.transfers.push(transfer);
  }

  importLinkedHistory(stateJson: string, transfer?: { old_signing_key: string; signature: string }) {
    const parsed = JSON.parse(stateJson) as Partial<PersistedE2eState> & Partial<LinkExportState>;
    if (parsed.linkVersion === 2) {
      // v2: без приватного материала
      const state = parsed as LinkExportState;
      Object.entries(state.decCache || {}).forEach(([uuid, inner]) => {
        if (!(uuid in this.decCache)) this.decCache[uuid] = inner;
      });
      Object.entries(state.groupIn || {}).forEach(([key, { exported, epoch }]) => {
        if (this.groupIn.has(key) || !exported) return;
        try {
          this.groupIn.set(key, { session: importInboundGroup(exported), epoch });
        } catch {
          // битый экспорт — пропускаем
        }
      });
      Object.entries(state.contacts || {}).forEach(([contact, identity]) => {
        if (!(contact in this.identityByContact)) this.identityByContact[contact] = identity;
        this.markSeen(contact, identity);
      });
      Object.entries(state.seenIdentities || {}).forEach(([contact, ids]) => {
        ids.forEach((identity) => this.markSeen(contact, identity));
      });
      (state.transfers || []).forEach((t) => this.addTransfer(t));
      this.addTransfer(transfer);
      this.queuePersist();
      return;
    }
    const state = parsed as PersistedE2eState;
    Object.entries(state.decCache || {}).forEach(([uuid, inner]) => {
      if (!(uuid in this.decCache)) this.decCache[uuid] = inner;
    });
    Object.entries(state.groupIn || {}).forEach(([key, { pickle, exported, epoch }]) => {
      if (this.groupIn.has(key)) return;
      try {
        if (exported) this.groupIn.set(key, { session: importInboundGroup(exported), epoch });
        else if (pickle) this.groupIn.set(key, { session: unpickleInboundGroup(pickle, state.pickleKey), epoch });
      } catch {
        // битый pickle — пропускаем, остальное импортируем
      }
    });
    // Аккаунт старого устройства (и его собственные legacy-подписанты —
    // цепочка линковок) становятся нашими подписантами sync: их
    // sealed-исходящие сервер отдаёт только по доказательству владения ключом
    [state.account, ...(state.legacyAccounts || [])].forEach((accountPickle) => {
      if (!accountPickle) return;
      this.adoptLegacySigner(accountPickle, state.pickleKey);
    });
    this.queuePersist();
  }

  private adoptLegacySigner(accountPickle: string, pickleKey: string) {
    try {
      const legacy = unpickleAccount(accountPickle, pickleKey);
      const signingKey = legacy.signingKey();
      const isDuplicate = signingKey === this.signingKey
        || this.legacySigners.some((signer) => signer.signingKey() === signingKey);
      if (isDuplicate) {
        legacy.free();
        return;
      }
      this.legacySigners.push(legacy);
    } catch {
      // битый pickle — подпись старых исходящих недоступна, остальное работает
    }
  }

  // Подписи sync-строки всеми legacy-подписантами (extra_signing в sync)
  signExtraSync(payload: string): { signing_key: string; signature: string }[] {
    return this.legacySigners.map((legacy) => ({
      signing_key: legacy.signingKey(), signature: legacy.sign(payload),
    }));
  }

  // Прокси «свежей неслинкованной установки»: ни одной Olm-сессии, пустой
  // кэш расшифровок и ни одного группового ключа — читать нечего, есть смысл
  // просить историю у других устройств. После импорта/переписки — false
  needsHistoryLink(): boolean {
    return this.sessionsByIdentity.size === 0
      && !Object.keys(this.decCache).length
      && this.groupIn.size === 0
      && this.legacySigners.length === 0
      && this.transfers.length === 0;
  }

  static async importEncrypted(self: string, payload: string, password: string): Promise<E2eEngine> {
    const parsed = JSON.parse(payload) as {
      v: number; iterations?: number; salt: string; iv: string; data: string;
    };
    if (parsed.v !== EXPORT_VERSION) throw new Error(`Unsupported key backup version: ${parsed.v}.`);
    // P-48: границы конверта — иначе чужой файл с iterations=10^9 вешает вкладку,
    // а соль/iv неверной длины делают KDF/GCM бессмысленными
    const envelope = validateBackupEnvelope(parsed);
    const key = await deriveExportKey(password, envelope.salt, envelope.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toStandaloneBuffer(envelope.iv) },
      key,
      toStandaloneBuffer(envelope.data),
    );
    const state = JSON.parse(new TextDecoder().decode(plaintext)) as PersistedE2eState;

    await loadOlm();
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
  // Ключи подписи ВСЕХ устройств контакта (для проверки сигналов звонка):
  // identity хранит один pubkey на пользователя — ключ последнего вошедшего
  // устройства, из-за чего звонок со второго устройства (телефон) отвергался
  async getContactSigningKeys(contact: string, fetchBundle: BundleFetcher): Promise<string[]> {
    await this.refreshContactDevices(contact, fetchBundle, true);
    const devices = this.devicesByContact.get(contact) || {};
    return Object.values(devices).map((device) => device.signing).filter(Boolean);
  }

  // Отпечатки identity-ключей устройств собеседника (для ручной сверки по
  // другому каналу). Пусто — устройства ещё не известны
  async getContactFingerprints(contact: string, fetchBundle?: BundleFetcher) {
    if (fetchBundle) await this.refreshContactDevices(contact, fetchBundle);
    const devices = this.devicesByContact.get(contact) || {};
    const entries = await Promise.all(Object.entries(devices).map(async ([deviceId, device]) => ({
      deviceId, fingerprint: await fingerprintOf(device.identity),
    })));
    return entries.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  getOwnFingerprint() {
    return fingerprintOf(this.identityKey);
  }

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
  private async refreshContactDevices(contact: string, fetchBundle: BundleFetcher, force = false) {
    const now = Date.now();
    const fetchedAt = this.deviceListFetchedAt.get(contact) || 0;
    if (!force && this.devicesByContact.has(contact) && now - fetchedAt < DEVICE_LIST_TTL_MS) return;

    let bundle: Awaited<ReturnType<BundleFetcher>>;
    try {
      bundle = await fetchBundle(contact);
    } catch {
      return;
    }
    if (!bundle?.ok) return;
    const fromDeviceList = Boolean(bundle.devices?.length);
    const devices: WireDeviceBundle[] = fromDeviceList ? bundle.devices! : (
      // Legacy identity без списка устройств — считаем его primary ('')
      bundle.identity_key ? [{
        device_id: '',
        signing_key: bundle.signing_key,
        identity_key: bundle.identity_key,
        signed_prekey: bundle.signed_prekey,
        signed_prekey_sig: bundle.signed_prekey_sig,
        one_time: bundle.one_time,
      }] : []
    );
    if (!devices.length) return;

    const next: Record<string, ContactDevice> = {};
    let accountChanged = false;
    let rejected = 0;
    devices.forEach((device) => {
      // Своё текущее устройство в списке самого себя — сессия не нужна
      if (!device.identity_key || device.identity_key === this.identityKey) return;
      // P-25: signed_prekey обязан быть подписан signing_key устройства —
      // иначе сервер подсовывает свой SPK (тихий DoS сессий). В списке
      // устройств подпись обязательна; legacy-бандл без signing_key
      // проверить нечем, принимаем как раньше
      if (fromDeviceList || device.signing_key || device.signed_prekey_sig) {
        if (!verifyPrekeySignature(device)) {
          rejected++;
          return;
        }
      }
      next[device.device_id] = { identity: device.identity_key, signing: device.signing_key || '' };
      if (this.sessionsByIdentity.has(device.identity_key)) return;
      const oneTimeKey = device.one_time || device.signed_prekey;
      if (!oneTimeKey) return;
      this.sessionsByIdentity.set(
        device.identity_key, this.account.createOutboundSession(device.identity_key, oneTimeKey),
      );
      accountChanged = true;
    });
    // Каталог целиком без валидных подписей — как недоступный: ничего не
    // перезаписываем, вердикт по такому контакту останется `unknown`
    if (rejected && !Object.keys(next).length) return;
    const previous = this.devicesByContact.get(contact);
    this.devicesByContact.set(contact, next);
    this.deviceListFetchedAt.set(contact, now);
    // P-04: первое знакомство с каталогом — текущие identity считаем
    // виденными (TOFU). Позже каталог множество НЕ засевает: принудительная
    // перечитка при промахе verifySender иначе спрятала бы смену ключа
    if (!this.seenIdentities.get(contact)?.size) {
      Object.values(next).forEach((device) => this.markSeen(contact, device.identity));
    }
    // Устройство контакта исчезло из каталога (отозвано) — ротируем общие
    // группы: групповой шифртекст рассылается всем, и без ротации отозванное
    // устройство продолжало бы читать НАШИ новые сообщения старым session key
    if (previous && Object.keys(previous).some((deviceId) => !(deviceId in next))) {
      this.rotateGroupsWith(contact);
    }
    if (!Object.keys(next).length) return;
    const primary = devices.find((device) => device.device_id === '') || devices[0];
    if (primary.identity_key !== this.identityKey) {
      this.identityByContact[contact] = primary.identity_key;
    }
    if (accountChanged) this.persistAccount();
    this.persistContacts();
  }

  // Прогрев каталога устройств контакта ДО выбора группового ключа: ротация от
  // обнаруженного отзыва (rotateGroupsWith) должна случиться до
  // getGroupSessionKey, иначе SKDM уедет со старым ключом, а groupEncrypt
  // упадёт на несовпадении эпохи
  async primeContactDevices(contact: string, fetchBundle: BundleFetcher) {
    await this.refreshContactDevices(contact, fetchBundle);
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
      const encrypted = encryptOlm(session, innerJson);
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
        if (existing?.matchesInbound(ciphertext)) {
          return existing.decrypt(ctype, ciphertext);
        }
        const { session, plaintext } = createInboundSession(this.account, senderIdentity, ciphertext);
        this.sessionsByIdentity.set(senderIdentity, session);
        return plaintext;
      }
      if (!existing) return undefined;
      return existing.decrypt(ctype, ciphertext);
    } catch {
      return undefined;
    }
  }

  // true — ключ собеседника СМЕНИЛСЯ (был другой): повод предупредить
  // пользователя, как «safety number changed» в Signal
  // P-04: смена определяется по множеству УЖЕ ВИДЕННЫХ identity контакта,
  // а не по identityByContact — его перезаписывает refreshContactDevices ещё
  // до этой проверки. Новое устройство контакта тоже считается сменой ключа
  // (как safety number в Signal) — пользователь сверяет отпечатки заново
  rememberContactIdentity(contact: string, identity: string): boolean {
    if (!contact || !identity || contact === this.self) return false;
    if (this.identityByContact[contact] !== identity) {
      this.identityByContact[contact] = identity;
    }
    const seen = this.seenIdentities.get(contact);
    if (seen?.has(identity)) {
      this.persistContacts();
      return false;
    }
    const changed = Boolean(seen?.size);
    this.markSeen(contact, identity);
    this.persistContacts();
    return changed;
  }

  // Виденные identity контакта (для UI/тестов)
  getSeenIdentities(contact: string): string[] {
    return Array.from(this.seenIdentities.get(contact) || []);
  }

  private markSeen(contact: string, identity: string) {
    if (!contact || !identity || identity === this.identityKey) return;
    let seen = this.seenIdentities.get(contact);
    if (!seen) {
      seen = new Set();
      this.seenIdentities.set(contact, seen);
    }
    seen.add(identity);
  }

  private seenIdentitiesSnapshot(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    this.seenIdentities.forEach((ids, contact) => {
      out[contact] = Array.from(ids);
    });
    return out;
  }

  // Аутентичность отправителя sealed-сообщения: sender_identity ОБЯЗАН
  // принадлежать заявленному отправителю по каталогу identity. Без этой сверки
  // любой пользователь мог бы прислать конверт с `inner.from` = кто угодно и
  // выдать себя за него (sealed sender скрывает отправителя от сервера, но не
  // подтверждает его получателю). Новое устройство отправителя не роняем:
  // при промахе принудительно перечитываем каталог, и только затем вердикт
  async verifySenderIdentity(
    claimedFrom: string,
    senderIdentity: string,
    fetchBundle: BundleFetcher,
  ): Promise<SenderVerdict> {
    if (!claimedFrom || !senderIdentity) return 'unknown';
    // Наше текущее устройство: подписывать себя может только self
    if (senderIdentity === this.identityKey) return claimedFrom === this.self ? 'ok' : 'spoofed';
    if (this.hasDeviceIdentity(claimedFrom, senderIdentity)) return 'ok';
    await this.refreshContactDevices(claimedFrom, fetchBundle, true);
    if (this.hasDeviceIdentity(claimedFrom, senderIdentity)) return 'ok';
    // Каталог получен (есть список устройств), но ключа в нём нет — подмена.
    // Каталог недоступен (сеть/шард) — подтвердить нельзя, не клеймим подменой
    return this.devicesByContact.has(claimedFrom) ? 'spoofed' : 'unknown';
  }

  private hasDeviceIdentity(contact: string, identity: string): boolean {
    const devices = this.devicesByContact.get(contact);
    if (devices && Object.values(devices).some((device) => device.identity === identity)) {
      return true;
    }
    // Legacy-снапшоты держат только primary-identity контакта
    return this.identityByContact[contact] === identity;
  }

  private loadIdentityKeys() {
    this.identityKey = this.account.identityKey();
    this.signingKey = this.account.signingKey();
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
      entry = { session: createOutboundGroup(), epoch: Date.now() };
      this.groupOut.set(group, entry);
      this.persistGroupOut();
    }
    return { sessionKey: entry.session.sessionKey(), epoch: entry.epoch };
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
    const epoch = Math.max(Date.now(), (previous?.epoch || 0) + 1);
    previous?.session.free();
    this.groupOut.set(group, { session: createOutboundGroup(), epoch });
    this.persistGroupOut();
  }

  // Отзыв СВОЕГО устройства (Settings → Devices): выбрасываем его из локального
  // каталога self (fan-out этой сессии сразу перестаёт слать ему копии) и
  // ротируем все исходящие групповые сессии — старый session key у отозванного
  // устройства не должен читать новые групповые сообщения. Новый ключ разъедется
  // штатным SKDM при следующей отправке в каждую группу
  forgetOwnDevice(deviceId: string) {
    const ownDevices = this.devicesByContact.get(this.self);
    if (ownDevices && deviceId in ownDevices) {
      delete ownDevices[deviceId];
      this.persistContacts();
    }
    this.deviceListFetchedAt.delete(this.self);
    this.groupOut.forEach((_entry, group) => this.rotateGroup(group));
  }

  // Ротация исходящих сессий всех групп, где участвует контакт (его устройство
  // отозвано). Новый ключ разъедется штатным SKDM при следующей отправке
  private rotateGroupsWith(contact: string) {
    this.groupRecipients.forEach((recipients, group) => {
      if (recipients.includes(contact) && this.groupOut.has(group)) {
        this.rotateGroup(group);
      }
    });
  }

  // Приём SKDM: принимаем ключ только строго новее известной эпохи (дедуп той
  // же, анти-откат старой, замена на ротацию)
  acceptGroupKey(group: string, senderIdentity: string, sessionKey: string, epoch: number) {
    const key = `${group}|${senderIdentity}`;
    const existing = this.groupIn.get(key);
    if (existing && epoch <= existing.epoch) return;
    try {
      this.groupIn.set(key, { session: createInboundGroup(sessionKey), epoch });
      this.persistGroupIn();
    } catch {
      // битый ключ — игнор
    }
  }

  groupDecrypt(group: string, senderIdentity: string, ciphertext: string): string | undefined {
    const entry = this.groupIn.get(`${group}|${senderIdentity}`);
    if (!entry) return undefined;
    try {
      const { plaintext } = decryptGroup(entry.session, ciphertext);
      this.persistGroupIn();
      return plaintext;
    } catch {
      return undefined;
    }
  }
}

// P-25: signed_prekey бандла подписан signing_key устройства (подпись — над
// base64-строкой ключа, как при публикации buildPrekeysPayload)
export function verifyPrekeySignature(device: WireDeviceBundle): boolean {
  if (!device.signing_key || !device.signed_prekey || !device.signed_prekey_sig) return false;
  return verifyEd25519(device.signing_key, device.signed_prekey, device.signed_prekey_sig);
}

const EXPORT_VERSION = 1;
const EXPORT_MIN_ITERATIONS = 310000;
// P-48: верхняя граница итераций PBKDF2 при импорте (защита от DoS чужим файлом)
export const EXPORT_MAX_ITERATIONS = 5_000_000;
const EXPORT_SALT_MIN = 16;
const EXPORT_SALT_MAX = 64;
const EXPORT_IV_LEN = 12;
export const EXPORT_DATA_MAX = 16 * 1024 * 1024;

/** P-48: проверка конверта бэкапа до KDF: число итераций в [min, max], соль 16..64 байт,
 *  iv 12 байт, данные ≤ 16 МиБ. Число итераций из файла не ниже минимума — подделанный
 *  бэкап с iterations=1 делал бы перебор пароля тривиальным. */
export function validateBackupEnvelope(parsed: {
  iterations?: number; salt: string; iv: string; data: string;
}): { iterations: number; salt: Uint8Array; iv: Uint8Array; data: Uint8Array } {
  const raw = parsed.iterations ?? EXPORT_MIN_ITERATIONS;
  if (!Number.isInteger(raw) || raw > EXPORT_MAX_ITERATIONS) {
    throw new Error('Key backup: unsupported PBKDF2 iteration count.');
  }
  const iterations = Math.max(raw, EXPORT_MIN_ITERATIONS);
  if (typeof parsed.salt !== 'string' || typeof parsed.iv !== 'string' || typeof parsed.data !== 'string') {
    throw new Error('Key backup: malformed envelope.');
  }
  if (parsed.data.length > Math.ceil(EXPORT_DATA_MAX / 3) * 4 + 4) {
    throw new Error('Key backup: payload too large.');
  }
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const data = base64ToBytes(parsed.data);
  if (salt.length < EXPORT_SALT_MIN || salt.length > EXPORT_SALT_MAX) {
    throw new Error('Key backup: bad salt length.');
  }
  if (iv.length !== EXPORT_IV_LEN) throw new Error('Key backup: bad iv length.');
  if (data.length < 16 || data.length > EXPORT_DATA_MAX) throw new Error('Key backup: bad payload length.');
  return { iterations, salt, iv, data };
}
const PERSIST_DEBOUNCE_MS = 250;
// OWASP-2023 минимум для PBKDF2-SHA256. Импорт читает iterations из самого
// бэкапа — старые экспорты на 310k остаются читаемыми
const EXPORT_KDF_ITERATIONS = 600000;

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
