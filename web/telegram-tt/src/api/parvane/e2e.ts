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
// eslint-disable-next-line import/no-unresolved
import olmWasmPath from '@matrix-org/olm/olm.wasm?url';

const PICKLE_KEY = 'parvane-web-pickle';
const ONE_TIME_BATCH = 20;

type BundleFetcher = (user: string) => Promise<{
  ok: boolean;
  identity_key?: string;
  signed_prekey?: string;
  one_time?: string;
} | undefined>;

type StoredInner = { from: string; content: unknown };

let isOlmReady = false;

export class E2eEngine {
  private account!: Olm.Account;

  private sessionsByIdentity = new Map<string, Olm.Session>();

  private identityByContact: Record<string, string> = {};

  private decCache: Record<string, StoredInner> = {};

  // Megolm: своя исходящая group-сессия на группу (+ эпоха для ротации) и
  // входящие сессии от участников, ключ = `${group}|${senderIdentity}`
  private groupOut = new Map<string, { session: Olm.OutboundGroupSession; epoch: number }>();

  private groupIn = new Map<string, { session: Olm.InboundGroupSession; epoch: number }>();

  private self = '';

  identityKey = '';

  static async create(self: string) {
    if (!isOlmReady) {
      // Emscripten-сборка olm читает глобаль OLM_OPTIONS и падает без неё
      (globalThis as { OLM_OPTIONS?: object }).OLM_OPTIONS = {};
      await Olm.init({ locateFile: () => olmWasmPath });
      isOlmReady = true;
    }
    const engine = new E2eEngine();
    engine.self = self;
    engine.load();
    return engine;
  }

  private storageKey(part: string) {
    return `parvane:e2e:${this.self}:${part}`;
  }

  private load() {
    this.account = new Olm.Account();
    const accountPickle = localStorage.getItem(this.storageKey('account'));
    if (accountPickle) {
      this.account.unpickle(PICKLE_KEY, accountPickle);
    } else {
      this.account.create();
      this.persistAccount();
    }
    this.identityKey = (JSON.parse(this.account.identity_keys()) as { curve25519: string }).curve25519;

    const sessions = JSON.parse(localStorage.getItem(this.storageKey('sessions')) || '{}') as Record<string, string>;
    Object.entries(sessions).forEach(([identity, pickle]) => {
      const session = new Olm.Session();
      session.unpickle(PICKLE_KEY, pickle);
      this.sessionsByIdentity.set(identity, session);
    });
    this.identityByContact = JSON.parse(localStorage.getItem(this.storageKey('contacts')) || '{}');
    this.decCache = JSON.parse(localStorage.getItem(this.storageKey('dec')) || '{}');

    const gout = JSON.parse(localStorage.getItem(this.storageKey('gout')) || '{}') as
      Record<string, { pickle: string; epoch: number }>;
    Object.entries(gout).forEach(([group, { pickle, epoch }]) => {
      const session = new Olm.OutboundGroupSession();
      session.unpickle(PICKLE_KEY, pickle);
      this.groupOut.set(group, { session, epoch });
    });
    const gin = JSON.parse(localStorage.getItem(this.storageKey('gin')) || '{}') as
      Record<string, { pickle: string; epoch: number }>;
    Object.entries(gin).forEach(([key, { pickle, epoch }]) => {
      const session = new Olm.InboundGroupSession();
      session.unpickle(PICKLE_KEY, pickle);
      this.groupIn.set(key, { session, epoch });
    });
  }

  private persistAccount() {
    localStorage.setItem(this.storageKey('account'), this.account.pickle(PICKLE_KEY));
  }

  private persistSessions() {
    const out: Record<string, string> = {};
    this.sessionsByIdentity.forEach((session, identity) => {
      out[identity] = session.pickle(PICKLE_KEY);
    });
    localStorage.setItem(this.storageKey('sessions'), JSON.stringify(out));
  }

  private persistContacts() {
    localStorage.setItem(this.storageKey('contacts'), JSON.stringify(this.identityByContact));
  }

  private persistDecCache() {
    localStorage.setItem(this.storageKey('dec'), JSON.stringify(this.decCache));
  }

  // Пачка публичных прекеев для identity-шарда. Публикуем ОДИН РАЗ на аккаунт:
  // повторный generate_one_time_keys+mark_keys_as_published каждый логин
  // приводил к рассинхрону OTK (BAD_MESSAGE_KEY_ID у получателя). Ключей на
  // аккаунт (fallback + 20 one-time) хватает; израсходование one-time не делает
  // сессию невозможной (X3DH-фолбэк на fallback-ключ).
  buildPrekeysPayload(token: string): unknown | undefined {
    if (localStorage.getItem(this.storageKey('published'))) return undefined;

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
    this.persistAccount();
    localStorage.setItem(this.storageKey('published'), '1');

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
    const out: Record<string, { pickle: string; epoch: number }> = {};
    this.groupOut.forEach(({ session, epoch }, group) => {
      out[group] = { pickle: session.pickle(PICKLE_KEY), epoch };
    });
    localStorage.setItem(this.storageKey('gout'), JSON.stringify(out));
  }

  private persistGroupIn() {
    const out: Record<string, { pickle: string; epoch: number }> = {};
    this.groupIn.forEach(({ session, epoch }, key) => {
      out[key] = { pickle: session.pickle(PICKLE_KEY), epoch };
    });
    localStorage.setItem(this.storageKey('gin'), JSON.stringify(out));
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

  groupEncrypt(group: string, plaintext: string) {
    const entry = this.groupOut.get(group);
    if (!entry) return undefined;
    const ciphertext = entry.session.encrypt(plaintext);
    this.persistGroupOut();
    return ciphertext;
  }

  // Ротация: сбрасываем свою исходящую (напр. участник удалён) — следующая
  // отправка создаст свежую с бОльшей эпохой и раздаст только текущим
  rotateGroup(group: string) {
    this.groupOut.delete(group);
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
