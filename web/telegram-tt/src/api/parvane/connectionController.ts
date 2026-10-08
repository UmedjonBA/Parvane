import type { ApiUpdate } from '../types';
import type { createCallController } from './calls';
import type { PollStore } from './polls';
import type { TaskOfferStore } from './taskOffers';

import { GatewayConnection } from './gateway';
import { loadTrustSecret, saveTrustSecret } from './secureStorage';
import { ParvaneStore } from './store';
import {
  TOPIC_DEVICE_LIST,
  TOPIC_IDENTITY_EMAIL_CONFIRM,
  TOPIC_IDENTITY_ISSUE,
  TOPIC_IDENTITY_REGISTER,
  TOPIC_IDENTITY_REGISTER_STATUS,
  TOPIC_IDENTITY_SERVER_INFO,
} from './wire';

type CallController = ReturnType<typeof createCallController>;

type ConnectionDependencies = {
  calls: CallController;
  getConnection: () => GatewayConnection | undefined;
  setConnection: (connection: GatewayConnection | undefined) => void;
  getStore: () => ParvaneStore;
  setStore: (store: ParvaneStore) => void;
  // P-39: шифрованное хранилище под PIN — разблокировать до чтения истории
  unlockStorage?: (user: string) => Promise<void>;
  /** Как устройство называет себя на экране «Устройства» («Firefox, Linux»). */
  describeDevice?: () => string;
  /** Стереть локальные данные устройства (ключи, историю): оно отозвано. */
  wipeDevice?: (user: string) => Promise<void>;
  getToken: () => string;
  setToken: (token: string) => void;
  setCallIdentityReady: (isReady: boolean) => void;
  polls: PollStore;
  taskOffers: TaskOfferStore;
  onNewSession: () => void;
  // Сессия поднята (auth + хранилище): точка старта движка v2 и фоновых
  // пост-логин задач (авто-линковка истории)
  onSessionReady?: () => void;
  resetSyncPromise: () => void;
  resolveDisplayNames: (addresses: string[]) => Promise<void>;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
  // Протокол v2: «печатает»/«в сети» — эфемерным каналом движка. Режим
  // «усиленная приватность» (правило L2-1): в чате с активным режимом
  // typing/presence не шлются и не показываются, своё присутствие не
  // публикуется, пока режим активен хотя бы в одном чате
  v2?: {
    ephemeralAllowed: (address: string) => boolean;
    presenceAllowed: () => boolean;
    publishPresence?: () => void;
    watchPresence?: (address: string) => void;
  };
  // FR-040: своя настройка «кто видит, что я в сети» — «никто»
  isPresenceHidden?: () => boolean;
};

const PRESENCE_INTERVAL_MS = 30000;
const PRESENCE_TTL_SECS = 90;
const TYPING_CLEAR_MS = 6000;

export type ConfirmMode = 'none' | 'email' | 'telegram';
export type ServerInfo = {
  domain: string;
  emailRequired: boolean;
  confirm: ConfirmMode;
  telegramBot: string;
};
export type RegisterResult = { confirmRequired: boolean; telegramToken?: string };

// Пароль верен, но включён двухфакторный вход: нужен Start в привязанном
// Telegram по deep link t.me/<bot>?start=<loginToken>, затем повторный логин с
// loginToken
export class TwoFactorRequiredError extends Error {
  constructor(public loginToken: string, public telegramBot: string) {
    super('нужно подтверждение входа в Telegram');
    this.name = 'TwoFactorRequiredError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Домен адресов, если сервер не сообщил свой: хост страницы; локальная
// разработка — «local» (дефолт PARVANE_DOMAIN у identity)
export function fallbackDomain() {
  const host = window.location.hostname.toLowerCase();
  return !host || LOCAL_HOSTS.has(host) ? 'local' : host;
}

// Полный адрес по вводу: «ник» → «ник@домен», «ник@сервер» — как есть
// (десктоп и старые аккаунты вводят адрес целиком)
export function canonicalAddress(input: string, domain: string) {
  const trimmed = input.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : `${trimmed}@${domain}`;
}

function fallbackServerInfo(): ServerInfo {
  return {
    domain: fallbackDomain(), emailRequired: false, confirm: 'none', telegramBot: '',
  };
}

// Текст отказа identity для токена отозванного устройства
const DEVICE_REVOKED_PATTERN = /устройство отозвано|ERROR_CODE_REVOKED/i;

export function createConnectionController(deps: ConnectionDependencies) {
  let lastServerInfo: ServerInfo | undefined;
  let presenceTimer: number | undefined;
  let sessionGeneration = 0;
  const typingClearTimers = new Map<string, number>();
  // P-18: presence — только конкретных собеседников, а не всех пользователей сервера
  const watchedPresence = new Set<string>();

  function deviceMirrorKey(user: string) {
    return `parvane:device:${user}`;
  }

  // Секрет доверия для 2FA: identity выдаёт его ОДИН раз после подтверждения
  // входа в Telegram, дальше доверенное устройство входит по паролю без
  // Telegram, предъявляя секрет. Раньше доверие висело на голом device_id,
  // который каталог отдаёт любому — второй фактор обходился при известном
  // пароле (security-review 8 сен 2026).
  function trustMirrorKey(user: string) {
    return `parvane:trust:${user}`;
  }

  // P-14: секрет доверия — в шифрованном хранилище (SecureE2eStorage), не в
  // localStorage. Старое значение из localStorage переносится и стирается
  async function readTrustSecretAsync(user: string) {
    try {
      const legacy = localStorage.getItem(trustMirrorKey(user)) || '';
      if (legacy) {
        await saveTrustSecret(user, legacy);
        localStorage.removeItem(trustMirrorKey(user));
        return legacy;
      }
    } catch {
      // приватный режим
    }
    return (await loadTrustSecret(user).catch(() => undefined)) || '';
  }

  async function writeTrustSecretAsync(user: string, secret: string) {
    if (!secret) return;
    try {
      await saveTrustSecret(user, secret);
    } catch (error) {
      deps.log(`секрет доверия не сохранён: ${String(error)}`);
    }
  }

  function readDeviceIdMirror(user: string) {
    try {
      return localStorage.getItem(deviceMirrorKey(user)) || '';
    } catch {
      return '';
    }
  }

  function writeDeviceIdMirror(user: string, deviceId: string) {
    try {
      if (deviceId) localStorage.setItem(deviceMirrorKey(user), deviceId);
    } catch {
      // приватный режим — без зеркала (claim dev появится позже)
    }
  }

  // Полный выход и отзыв устройства: следующий вход — новое устройство. Прежний
  // идентификатор не годится: его ключи стёрты, а отозванный сервер не примет
  // никогда (вход с верным паролем выглядел бы как «неверный пароль»)
  function forgetDeviceId(user: string) {
    try {
      localStorage.removeItem(deviceMirrorKey(user));
    } catch {
      // приватный режим — зеркала и не было
    }
  }

  // `implicitRegister` — сервер без подтверждения (dev/e2e): неизвестный ник
  // регистрируется прямо при входе. С подтверждением (почта/Telegram) вход
  // только для существующих аккаунтов — иначе опечатка в нике заводила бы
  // pending-аккаунт и вела на экран подтверждения чужого ника
  async function issueToken(
    activeConnection: GatewayConnection, user: string, password: string, implicitRegister: boolean, loginToken = '',
  ) {
    const issue = async () => {
      // device_id — из зеркала localStorage, а для свежей установки генерируется
      // прямо здесь: уже ПЕРВЫЙ JWT несёт claim dev, и отзыв устройства гасит его
      // токены сразу; движок v2 берёт id устройства из JWT
      let deviceId = readDeviceIdMirror(user);
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        writeDeviceIdMirror(user, deviceId);
      }
      const raw = await activeConnection.request(
        TOPIC_IDENTITY_ISSUE,
        JSON.stringify({
          user,
          password,
          device_id: deviceId || undefined,
          client: deps.describeDevice?.(),
          login_token: loginToken || undefined,
          trust_secret: (await readTrustSecretAsync(user)) || undefined,
        }),
      );
      const parsed = JSON.parse(raw) as {
        ok: boolean;
        token?: string;
        error?: string;
        twofa_required?: boolean;
        login_token?: string;
        telegram_bot?: string;
        trust_secret?: string;
      };
      if (parsed.trust_secret) await writeTrustSecretAsync(user, parsed.trust_secret);
      return parsed;
    };

    let response = await issue();
    if (response.twofa_required && response.login_token) {
      throw new TwoFactorRequiredError(response.login_token, response.telegram_bot || '');
    }
    if (!response.ok && implicitRegister) {
      const raw = await activeConnection.request(
        TOPIC_IDENTITY_REGISTER,
        JSON.stringify({ user, password, invite: '' }),
      );
      const registration = JSON.parse(raw) as { ok: boolean; error?: string };
      if (registration.ok) {
        response = await issue();
      } else if (registration.error && registration.error.toLowerCase().includes('email')) {
        // Сервер с обязательной почтой отклонил безпочтовую регистрацию нового
        // аккаунта («нужен корректный email») — это НОВЫЙ логин, ведём на экран
        // email. Ошибку issue не раскрываем: она унифицирована анти-энумерацией,
        // а существование аккаунта здесь определяет ответ register
        throw new Error('нужна регистрация через почту');
      }
    }
    if (!response.ok || !response.token) {
      throw new Error(response.error || 'identity отказал в выдаче токена');
    }
    return response.token;
  }

  // «В сети» по эфемерному каналу v2 (T134): автора проверил движок
  function showV2Presence(from: string) {
    const store = deps.getStore();
    if (!from || from === store.self) return;
    // L2-1: собеседник чата с режимом «усиленная приватность» «в сети» не показывается
    if (!isEphemeralAllowed(from)) return;
    deps.sendUpdate({
      '@type': 'updateUserStatus',
      userId: store.getIdForAddress(from),
      status: { type: 'userStatusOnline', expires: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECS },
    });
  }

  // «Печатает» по эфемерному каналу v2 (T127): автор и чат уже проверены
  // движком (канал знают только участники чата)
  function showV2Typing(chat: string, from: string) {
    const store = deps.getStore();
    if (!from || from === store.self) return;
    showTyping(from, store.isGroupAddress(chat) ? chat : undefined);
  }

  function showTyping(from: string, groupAddress?: string) {
    const store = deps.getStore();
    // L2-1: в чате с режимом «усиленная приватность» typing не показывается
    if (!isEphemeralAllowed(groupAddress || from)) return;
    // Групповой typing: печатает участник — показываем в групповом чате.
    // Личный: показываем в 1-1 чате собеседника (по `from`)
    const chatId = groupAddress
      ? store.getIdForAddress(groupAddress, 'group')
      : store.getIdForAddress(from);
    deps.sendUpdate({
      '@type': 'updateChatTypingStatus',
      id: chatId,
      peerId: chatId,
      typingStatus: { type: 'typing', timestamp: Math.floor(Date.now() / 1000) },
    });
    window.clearTimeout(typingClearTimers.get(chatId));
    typingClearTimers.set(chatId, window.setTimeout(() => {
      deps.sendUpdate({
        '@type': 'updateChatTypingStatus', id: chatId, peerId: chatId, typingStatus: undefined,
      });
    }, TYPING_CLEAR_MS));
  }

  function isEphemeralAllowed(address: string) {
    return deps.v2?.ephemeralAllowed(address) ?? true;
  }

  function isPresenceWanted(peerId: string) {
    const address = deps.getStore().getAddressForId(peerId);
    return !address || isEphemeralAllowed(address);
  }

  // Режим L2 чата сменился. Включён: убрать показанные «печатает»/«в сети» и
  // больше не слушать presence собеседника. Выключен: подписаться заново
  function refreshEphemeral(address: string) {
    const store = deps.getStore();
    const isGroup = store.isGroupAddress(address);
    const chatId = store.getIdForAddress(address, isGroup ? 'group' : 'user');
    if (isEphemeralAllowed(address)) {
      if (!isGroup) ensurePresence(chatId);
    } else {
      window.clearTimeout(typingClearTimers.get(chatId));
      typingClearTimers.delete(chatId);
      deps.sendUpdate({
        '@type': 'updateChatTypingStatus', id: chatId, peerId: chatId, typingStatus: undefined,
      });
      // Кадры presence собеседника гасит обработчик (`showV2Presence`)
      if (!isGroup) {
        deps.sendUpdate({ '@type': 'updateUserStatus', userId: chatId, status: { type: 'userStatusRecently' } });
      }
    }
    // Своё присутствие одно на аккаунт: режим сняли везде — публикуем сразу
    publishPresence();
  }

  // Присутствие собеседника (идемпотентно): зовётся при появлении адреса
  // пользователя в сторе — движок слушает его эфемерный канал
  function ensurePresence(peerId: string) {
    if (!peerId || peerId.startsWith('-') || watchedPresence.has(peerId)) return;
    // L2-1: на presence собеседника L2-чата не подписываемся
    if (!isPresenceWanted(peerId)) return;
    watchedPresence.add(peerId);
    const address = deps.getStore().getAddressForId(peerId);
    if (address) deps.v2?.watchPresence?.(address);
  }

  function publishPresence() {
    if (!deps.getConnection()) return;
    // L2-1: присутствие одно на аккаунт — молчим, пока режим активен хоть в одном чате
    if (deps.v2 && !deps.v2.presenceAllowed()) return;
    // FR-040: «кто видит, что я в сети — никто» — присутствие не публикуется вовсе
    if (deps.isPresenceHidden?.()) return;
    deps.v2?.publishPresence?.();
  }

  // `input` — ник или полный адрес; голый ник дополняется доменом сервера.
  // Возвращает полный адрес аккаунта
  // P-39: возобновление сессии по сохранённому JWT (без пароля). Протухший/
  // отозванный токен отвергает первый же запрос v2 → ошибка
  async function connectWithToken(user: string, savedToken: string): Promise<string> {
    return connectAndLogin(user, '', '', savedToken);
  }

  async function connectAndLogin(
    input: string, password: string, loginToken = '', savedToken = '', isNewDeviceRetry = false,
  ): Promise<string> {
    // Новая сессия — состав собеседников (и их presence) будет пересобран движком
    watchedPresence.clear();
    const generation = ++sessionGeneration;
    deps.calls.teardown();
    window.clearInterval(presenceTimer);
    const activeConnection = new GatewayConnection();
    deps.setConnection(activeConnection);

    try {
      const info = await requestServerInfo(activeConnection);
      lastServerInfo = info;
      const user = canonicalAddress(input, info.domain);

      const nextToken = savedToken
        || await issueToken(activeConnection, user, password, info.confirm === 'none', loginToken);
      deps.setToken(nextToken);
      deps.log('JWT получен');
      activeConnection.authorize(nextToken);
      try {
        // Отзыв устройства сервер сообщит лишь на первом запросе v2. Спрашиваем
        // сразу, пока пароль под рукой, — иначе вход отозванного устройства
        // зацикливался на экране пароля
        if (!savedToken) {
          const probe = JSON.parse(
            await activeConnection.request(TOPIC_DEVICE_LIST, JSON.stringify({ token: nextToken })),
          ) as { ok?: boolean; error?: string };
          if (!probe.ok && DEVICE_REVOKED_PATTERN.test(probe.error || '')) throw new Error(probe.error);
        }
      } catch (error) {
        // Пароль верный (токен выдан), а токен не принят — устройство отозвано
        // другим («Завершить все другие сеансы»). Входим как новое устройство
        // Только явный отказ «устройство отозвано»: обрыв связи посреди входа не
        // должен стирать локальные ключи и историю
        const isRevoked = DEVICE_REVOKED_PATTERN.test(String(error));
        if (savedToken || isNewDeviceRetry || !isRevoked || !deps.wipeDevice) throw error;
        deps.log('токен устройства не принят (устройство отозвано) — вход новым устройством');
        await deps.wipeDevice(user);
        forgetDeviceId(user);
        return await connectAndLogin(input, password, loginToken, '', true);
      }
      deps.log(`авторизован: ${user}`);

      const store = new ParvaneStore();
      store.self = user;
      deps.setStore(store);
      deps.polls.setSelf(user);
      deps.polls.setPeerIdResolver((address) => deps.getStore().getIdForAddress(address));
      deps.taskOffers.setSelf(user);
      deps.taskOffers.setPeerIdResolver((address) => deps.getStore().getIdForAddress(address));
      deps.onNewSession();

      deps.setCallIdentityReady(false);
      try {
        await deps.unlockStorage?.(user);
      } catch (error) {
        deps.log(`хранилище не разблокировано: ${String(error)}`);
      }
      // Звонки: сигналы идут запечатанными конвертами v2 — отдельного ключа не нужно
      deps.setCallIdentityReady(true);

      if (generation !== sessionGeneration) throw new Error('Вход прерван новой сессией');
      deps.calls.setup();

      await deps.resolveDisplayNames([user]);
      deps.log('имена получены, шлю ready-апдейты');
      const currentUser = deps.getStore().buildApiUser(user);
      deps.sendUpdate({ '@type': 'updateCurrentUser', currentUser, currentUserFullInfo: {} });
      deps.sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateReady' });
      deps.sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });

      presenceTimer = window.setInterval(publishPresence, PRESENCE_INTERVAL_MS);
      publishPresence();
      deps.onSessionReady?.();
      return user;
    } catch (error) {
      if (generation === sessionGeneration && deps.getConnection() === activeConnection) {
        deps.setConnection(undefined);
        deps.setToken('');
      }
      throw error;
    }
  }

  // Pre-auth запрос (для флоу регистрации, когда постоянной сессии ещё нет)
  async function requestPreAuth<T>(subject: string, payload: unknown): Promise<T> {
    const raw = await new GatewayConnection().request(subject, JSON.stringify(payload));
    return JSON.parse(raw) as T;
  }

  // Публичные параметры сервера для экрана входа: домен адресов (ник →
  // ник@домен) и нужна ли почта при регистрации. Сервер недоступен — фолбэк по
  // хосту страницы: e2e и dev ходят на localhost, где identity по умолчанию
  // отвечает за домен «local»
  async function requestServerInfo(activeConnection: GatewayConnection): Promise<ServerInfo> {
    try {
      const raw = await activeConnection.request(TOPIC_IDENTITY_SERVER_INFO, JSON.stringify({}));
      const info = JSON.parse(raw) as {
        domain?: string; email_required?: boolean; confirm?: string; telegram_bot?: string;
      };
      if (info.domain) {
        const confirm: ConfirmMode = info.confirm === 'telegram' || info.confirm === 'email'
          ? info.confirm
          : (info.email_required ? 'email' : 'none');
        return {
          domain: info.domain,
          emailRequired: confirm === 'email',
          confirm,
          telegramBot: info.telegram_bot || '',
        };
      }
    } catch (err) {
      deps.log(`server.info недоступен, домен по хосту: ${String(err)}`);
    }
    return fallbackServerInfo();
  }

  // Для формы регистрации (сессии ещё нет)
  async function fetchServerInfo(): Promise<ServerInfo> {
    const info = await requestServerInfo(new GatewayConnection());
    lastServerInfo = info;
    return info;
  }

  // Последний ответ server.info (логин или отдельный запрос)
  function getLastServerInfo() {
    return lastServerInfo;
  }

  // Подтверждён ли pending-аккаунт (режим Telegram: бот получил Start)
  async function fetchRegisterStatus(user: string, token: string) {
    const response = await requestPreAuth<{ confirmed?: boolean }>(
      TOPIC_IDENTITY_REGISTER_STATUS,
      { user, token },
    );
    return Boolean(response.confirmed);
  }

  // Регистрация. confirmRequired — сервер ждёт подтверждения: код с почты
  // (identity.email.confirm) или Start в Telegram-боте (telegramToken для
  // deep link); иначе аккаунт сразу активен. Повторный вызов для
  // pending-аккаунта с тем же паролем — перевысылка кода / новый токен
  async function registerAccount(user: string, password: string, email: string): Promise<RegisterResult> {
    const response = await requestPreAuth<{
      ok: boolean; error?: string; confirm_required?: boolean; telegram_token?: string;
    }>(
      TOPIC_IDENTITY_REGISTER,
      {
        user, password, invite: '', email,
      },
    );
    if (!response.ok) {
      throw new Error(response.error || 'identity отказал в регистрации');
    }
    return { confirmRequired: Boolean(response.confirm_required), telegramToken: response.telegram_token };
  }

  async function confirmEmail(user: string, code: string) {
    const response = await requestPreAuth<{ ok: boolean; error?: string }>(
      TOPIC_IDENTITY_EMAIL_CONFIRM,
      { user, code },
    );
    if (!response.ok) {
      throw new Error(response.error || 'identity отклонил код');
    }
  }

  function shutdown() {
    sessionGeneration += 1;
    deps.calls.teardown();
    deps.setConnection(undefined);
    deps.setToken('');
    deps.setCallIdentityReady(false);
    deps.resetSyncPromise();
    window.clearInterval(presenceTimer);
    typingClearTimers.forEach((timer) => window.clearTimeout(timer));
    typingClearTimers.clear();
    watchedPresence.clear();
  }

  return {
    connectAndLogin,
    writeTrustSecret: writeTrustSecretAsync,
    registerAccount,
    confirmEmail,
    fetchServerInfo,
    getLastServerInfo,
    fetchRegisterStatus,
    ensurePresence,
    refreshEphemeral,
    showV2Typing,
    showV2Presence,
    connectWithToken,
    rememberDeviceId: writeDeviceIdMirror,
    currentDeviceId: readDeviceIdMirror,
    forgetDeviceId,
    shutdown,
  };
}
