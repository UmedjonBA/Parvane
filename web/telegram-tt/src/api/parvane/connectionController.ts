import type { ApiUpdate } from '../types';
import type { createCallController } from './calls';
import type { PollStore } from './polls';

import { E2eEngine } from './e2e';
import { GatewayConnection, getGatewayUrl } from './gateway';
import { loadTrustSecret, saveTrustSecret } from './secureStorage';
import { ParvaneStore } from './store';
import {
  buildCallInboxTopic,
  buildGroupCallRoute,
  buildMsgInboxTopic,
  buildPresenceTopic,
  buildTypingTopic,
  TOPIC_DEVICE_LIST,
  TOPIC_IDENTITY_EMAIL_CONFIRM,
  TOPIC_IDENTITY_ISSUE,
  TOPIC_IDENTITY_REGISTER,
  TOPIC_IDENTITY_REGISTER_STATUS,
  TOPIC_IDENTITY_SERVER_INFO,
  TOPIC_IDENTITY_SETKEY,
  TOPIC_PREKEYS_PUBLISH,
} from './wire';

type CallController = ReturnType<typeof createCallController>;

type ConnectionDependencies = {
  calls: CallController;
  getConnection: () => GatewayConnection | undefined;
  setConnection: (connection: GatewayConnection | undefined) => void;
  getE2e: () => E2eEngine | undefined;
  setE2e: (engine: E2eEngine | undefined) => void;
  getStore: () => ParvaneStore;
  setStore: (store: ParvaneStore) => void;
  // P-39: хранилище под PIN — разблокировать до открытия E2E
  unlockStorage?: (user: string) => Promise<void>;
  /** Как устройство называет себя на экране «Устройства» («Firefox, Linux»). */
  describeDevice?: () => string;
  /** Стереть локальные данные устройства (ключи, историю): оно отозвано. */
  wipeDevice?: (user: string) => Promise<void>;
  getToken: () => string;
  setToken: (token: string) => void;
  setCallIdentityReady: (isReady: boolean) => void;
  polls: PollStore;
  onNewSession: () => void;
  // Сессия полностью поднята (auth + E2E + подписки): точка старта фоновых
  // пост-логин задач (авто-линковка истории)
  onSessionReady?: () => void;
  isSynced: () => boolean;
  resetSyncPromise: () => void;
  requestDeltaSync: () => void;
  requestFullSync: () => void;
  resolveDisplayNames: (addresses: string[]) => Promise<void>;
  handleInboxFrame: (payload: string) => void;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
  // Протокол v2, режим «усиленная приватность» (правило L2-1): в чате с
  // активным режимом typing/presence не шлются и не показываются, своё
  // присутствие не публикуется, пока режим активен хотя бы в одном чате
  v2?: {
    ephemeralAllowed: (address: string) => boolean;
    presenceAllowed: () => boolean;
    // Присутствие эфемерным каналом v2 (T134): без соединения v1 — единственный путь
    publishPresence?: () => void;
    watchPresence?: (address: string) => void;
  };
  // FR-040: своя настройка «кто видит, что я в сети» — «никто»
  isPresenceHidden?: () => boolean;
};

// Остаток one-time prekeys на сервере, ниже которого доливаем свежую пачку
const OTK_REPLENISH_THRESHOLD = 5;
const DELTA_SYNC_INTERVAL_MS = 10000;
const PRESENCE_INTERVAL_MS = 30000;
const PRESENCE_TTL_SECS = 90;
const TYPING_CLEAR_MS = 6000;
const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 10000;

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

// Текст отказа identity/gateway для токена отозванного устройства
const DEVICE_REVOKED_PATTERN = /устройство отозвано|ERROR_CODE_REVOKED/i;

export function createConnectionController(deps: ConnectionDependencies) {
  let lastServerInfo: ServerInfo | undefined;
  let syncTimer: number | undefined;
  let presenceTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let sessionGeneration = 0;
  const typingClearTimers = new Map<string, number>();
  // Групповые typing-топики (msg.typing.<groupChatId>), на которые подписаны —
  // переустанавливаются на каждом (пере)подключении
  const subscribedTypingGroups = new Set<string>();
  // P-18: presence — только конкретных собеседников (presence.<id>), а не
  // presence.* всех пользователей сервера; gateway wildcard больше не даёт
  const subscribedPresence = new Set<string>();

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
      // device_id — из зеркала (E2eEngine.create), а для свежей установки
      // генерируется прямо здесь и передаётся движку: уже ПЕРВЫЙ JWT несёт
      // claim dev, и отзыв устройства гасит его токены сразу
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

  function handleTypingFrame(payload: string) {
    let frame: { from?: string; to?: string };
    try {
      frame = JSON.parse(payload) as { from?: string; to?: string };
    } catch {
      return;
    }
    const { from, to } = frame;
    const store = deps.getStore();
    if (!from || from === store.self) return;

    // P-44: `to` — из кадра отправителя, не доверяем: групповой typing только
    // для известной группы, где `from` состоит; личный — только адресованный нам
    const isGroup = Boolean(to && store.isGroupAddress(to));
    if (isGroup) {
      const members = store.getGroupInfo(to!)?.members || [];
      if (!members.some((member) => member.address === from && member.role !== 'banned')) return;
    } else if (to && to !== store.self) {
      return;
    }
    showTyping(from, isGroup ? to : undefined);
  }

  // «Печатает» по эфемерному каналу v2 (T127): автор и чат уже проверены
  // движком (канал знают только участники чата)
  // «В сети» по эфемерному каналу v2 (T134): автора проверил движок
  function showV2Presence(from: string) {
    handlePresenceFrame(JSON.stringify({ from }));
  }

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

  function handlePresenceFrame(payload: string) {
    let from: string | undefined;
    try {
      from = (JSON.parse(payload) as { from?: string }).from;
    } catch {
      return;
    }
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
      // Отписки у gateway нет: кадры presence собеседника гасит обработчик
      if (!isGroup) {
        deps.sendUpdate({ '@type': 'updateUserStatus', userId: chatId, status: { type: 'userStatusRecently' } });
      }
    }
    // Своё присутствие одно на аккаунт: режим сняли везде — публикуем сразу
    publishPresence();
  }

  function activate(activeConnection: GatewayConnection, user: string, generation: number) {
    deps.setConnection(activeConnection);
    activeConnection.onClose = () => handleClose(activeConnection, user, generation);
    activeConnection.subscribe(buildMsgInboxTopic(user), deps.handleInboxFrame);
    activeConnection.subscribe(buildTypingTopic(deps.selfId()), handleTypingFrame);
    subscribedPresence.forEach((peerId) => {
      // L2-1: на новом соединении presence собеседника L2-чата не слушаем
      if (!isPresenceWanted(peerId)) {
        subscribedPresence.delete(peerId);
        return;
      }
      activeConnection.subscribe(buildPresenceTopic(peerId), handlePresenceFrame);
    });
    activeConnection.subscribe(buildCallInboxTopic(user), deps.calls.handleFrame);
    activeConnection.subscribe(buildCallInboxTopic(buildGroupCallRoute(user)), deps.calls.handleGroupFrame);
    // Переустанавливаем подписки на typing-топики известных групп
    subscribedTypingGroups.forEach((groupChatId) => {
      activeConnection.subscribe(buildTypingTopic(groupChatId), handleTypingFrame);
    });
    deps.calls.setup();
  }

  // Подписка на presence собеседника (идемпотентно): зовётся при появлении
  // адреса пользователя в сторе; на reconnect переустанавливается в `activate`
  function ensurePresence(peerId: string) {
    if (!peerId || peerId.startsWith('-') || subscribedPresence.has(peerId)) return;
    // L2-1: на presence собеседника L2-чата не подписываемся
    if (!isPresenceWanted(peerId)) return;
    subscribedPresence.add(peerId);
    deps.getConnection()?.subscribe(buildPresenceTopic(peerId), handlePresenceFrame);
    const address = deps.getStore().getAddressForId(peerId);
    if (address) deps.v2?.watchPresence?.(address);
  }

  // Подписка на групповой typing-топик (идемпотентно). Вызывается при
  // регистрации группы; на reconnect переустанавливается в `activate`
  function ensureGroupTyping(groupChatId: string) {
    if (!groupChatId || subscribedTypingGroups.has(groupChatId)) return;
    subscribedTypingGroups.add(groupChatId);
    deps.getConnection()?.subscribe(buildTypingTopic(groupChatId), handleTypingFrame);
  }

  function handleClose(closedConnection: GatewayConnection, user: string, generation: number) {
    if (generation !== sessionGeneration || deps.getConnection() !== closedConnection) return;
    deps.setConnection(undefined);
    deps.calls.teardown();
    deps.sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
    scheduleReconnect(user, generation);
  }

  function scheduleReconnect(user: string, generation: number) {
    if (reconnectTimer || !deps.getToken() || generation !== sessionGeneration) return;
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * (2 ** reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt = Math.min(reconnectAttempt + 1, 16);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void reconnect(user, generation);
    }, delay);
  }

  async function reconnect(user: string, generation: number) {
    const currentToken = deps.getToken();
    if (!currentToken || generation !== sessionGeneration || deps.getStore().self !== user) return;
    const nextConnection = new GatewayConnection();
    try {
      await nextConnection.connect(getGatewayUrl());
      await nextConnection.authorize(currentToken);
      if (generation !== sessionGeneration || deps.getToken() !== currentToken) {
        nextConnection.close();
        return;
      }
      if (!nextConnection.isOpen) throw new Error('Соединение с gateway закрыто во время авторизации');
      activate(nextConnection, user, generation);
      reconnectAttempt = 0;
      deps.sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });
      publishPresence();
      if (deps.isSynced()) {
        deps.requestDeltaSync();
      } else {
        // Первичный синк упал (таймаут/обрыв) — раньше просто сбрасывали memo
        // и список чатов оставался пустым до перезагрузки
        deps.resetSyncPromise();
        deps.requestFullSync();
      }
      deps.log('соединение с gateway восстановлено');
    } catch (error) {
      if (deps.getConnection() === nextConnection) deps.setConnection(undefined);
      nextConnection.close();
      deps.log(`повторное подключение не удалось: ${String(error)}`);
      scheduleReconnect(user, generation);
    }
  }

  function cancelReconnect() {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectAttempt = 0;
  }

  function publishPresence() {
    const connection = deps.getConnection();
    if (!connection) return;
    // L2-1: присутствие одно на аккаунт — молчим, пока режим активен хоть в одном чате
    if (deps.v2 && !deps.v2.presenceAllowed()) return;
    // FR-040: «кто видит, что я в сети — никто» — присутствие не публикуется вовсе
    if (deps.isPresenceHidden?.()) return;
    try {
      connection.publish(buildPresenceTopic(deps.selfId()), JSON.stringify({ from: deps.getStore().self }));
    } catch {
      // onClose запустит reconnect; presence будет опубликован после auth.
    }
    // То же эфемерным каналом v2: без соединения v1 это единственный путь
    deps.v2?.publishPresence?.();
  }

  // `input` — ник или полный адрес; голый ник дополняется доменом сервера
  // (server.info запрашивается на этом же соединении — лишних сокетов нет).
  // Возвращает полный адрес аккаунта
  // P-39: возобновление сессии по сохранённому JWT (без пароля). Токен
  // проверяется identity через gateway auth; протухший/отозванный → ошибка
  async function connectWithToken(user: string, savedToken: string): Promise<string> {
    return connectAndLogin(user, '', '', savedToken);
  }

  async function connectAndLogin(
    input: string, password: string, loginToken = '', savedToken = '', isNewDeviceRetry = false,
  ): Promise<string> {
    cancelReconnect();
    // Новая сессия — состав групп (и их typing-подписки) будет пересобран синком
    subscribedTypingGroups.clear();
    subscribedPresence.clear();
    const generation = ++sessionGeneration;
    deps.calls.teardown();
    deps.getConnection()?.close();
    window.clearInterval(syncTimer);
    window.clearInterval(presenceTimer);
    const activeConnection = new GatewayConnection();
    deps.setConnection(activeConnection);

    try {
      await activeConnection.connect(getGatewayUrl());
      deps.log('WS открыт');

      const info = await requestServerInfo(activeConnection);
      lastServerInfo = info;
      const user = canonicalAddress(input, info.domain);

      const nextToken = savedToken
        || await issueToken(activeConnection, user, password, info.confirm === 'none', loginToken);
      deps.setToken(nextToken);
      deps.log('JWT получен');
      try {
        await activeConnection.authorize(nextToken);
        // Без соединения v1 авторизация условна: отзыв устройства сервер сообщит
        // лишь на первом запросе v2. Спрашиваем сразу, пока пароль под рукой, —
        // иначе вход отозванного устройства зацикливался на экране пароля
        if (activeConnection.hasV1 === false && !savedToken) {
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
        // Отказ в авторизации gateway завершает закрытием соединения — входим заново
        return await connectAndLogin(input, password, loginToken, '', true);
      }
      deps.log(`авторизован: ${user}`);

      const store = new ParvaneStore();
      store.self = user;
      deps.setStore(store);
      deps.polls.setSelf(user);
      deps.polls.setPeerIdResolver((address) => deps.getStore().getIdForAddress(address));
      deps.onNewSession();

      deps.setCallIdentityReady(false);
      try {
        await deps.unlockStorage?.(user);
        const nextE2e = await E2eEngine.create(user, readDeviceIdMirror(user));
        deps.setE2e(nextE2e);
        writeDeviceIdMirror(user, nextE2e.deviceId);
        // T134: соединения v1 нет (сервер его отключил) — каталог прекеев v1
        // недоступен, движок v1 нужен локально (история, копия ключей, линковка)
        const isV1Absent = activeConnection.hasV1 === false;
        const prekeys = isV1Absent ? undefined : nextE2e.buildPrekeysPayload(nextToken);
        if (isV1Absent) {
          deps.log('E2E готов (v1 отключён сервером — прекеи v1 не публикуются)');
        } else if (prekeys) {
          await nextE2e.flushStorage();
          const published = JSON.parse(
            await activeConnection.request(TOPIC_PREKEYS_PUBLISH, JSON.stringify(prekeys)),
          ) as { ok?: boolean; error?: string };
          // У аккаунта на v2 устройство без сертификата журнала в каталог v1 не
          // попадает (T048) — бандл дошлётся после привязки (replenishDevicePrekeys)
          deps.log(published.ok ? 'E2E готов, прекеи опубликованы'
            : `E2E готов, прекеи identity не принял: ${published.error || 'отказ'}`);
        } else {
          deps.log('E2E готов (прекеи уже опубликованы ранее)');
        }
      } catch (error) {
        deps.setE2e(undefined);
        deps.log(`E2E недоступен: ${String(error)}`);
      }

      // Пополнение one-time prekeys при просевшем серверном остатке —
      // fire-and-forget, вход не тормозим
      void replenishOneTimePrekeys(activeConnection, nextToken);

      // Ключ подписи звонков. Собеседники проверяют подпись по signing-ключам
      // устройств из каталога прекеев и по `pubkey` из identity, поэтому
      // устройство готово к звонкам, как только его ключ опубликован в каталоге
      // (выше). `setkey` записывает «ключ последнего вошедшего» для клиентов,
      // читающих только `pubkey`: замену уже записанного ключа сервер принимает
      // лишь с паролем (P-07), а при возобновлении сессии по токену пароля нет
      // (P-39) — раньше отказ выключал звонки на втором устройстве целиком
      const nextE2e = deps.getE2e();
      if (nextE2e) {
        deps.setCallIdentityReady(true);
      }
      if (nextE2e && activeConnection.hasV1 !== false) {
        try {
          const raw = await activeConnection.request(TOPIC_IDENTITY_SETKEY, JSON.stringify({
            token: nextToken,
            pubkey: nextE2e.signingKey,
            password: password || undefined,
          }));
          const response = JSON.parse(raw) as { ok?: boolean; error?: string };
          if (!response.ok) throw new Error(response.error || 'Call identity key registration failed');
        } catch (error) {
          deps.log(`pubkey в identity не обновлён (звонки идут по ключу устройства из каталога): ${String(error)}`);
        }
      }

      if (!activeConnection.isOpen) throw new Error('Соединение с gateway закрыто во время входа');
      activate(activeConnection, user, generation);

      await deps.resolveDisplayNames([user]);
      deps.log('имена получены, шлю ready-апдейты');
      const currentUser = deps.getStore().buildApiUser(user);
      deps.sendUpdate({ '@type': 'updateCurrentUser', currentUser, currentUserFullInfo: {} });
      deps.sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateReady' });
      deps.sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });

      syncTimer = window.setInterval(deps.requestDeltaSync, DELTA_SYNC_INTERVAL_MS);
      presenceTimer = window.setInterval(publishPresence, PRESENCE_INTERVAL_MS);
      publishPresence();
      deps.onSessionReady?.();
      return user;
    } catch (error) {
      if (generation === sessionGeneration && deps.getConnection() === activeConnection) {
        deps.setConnection(undefined);
        deps.setToken('');
      }
      activeConnection.close();
      throw error;
    }
  }

  // Каждый fetch нашего бандла новым собеседником сжигает по одной one-time
  // prekey; без пополнения X3DH деградирует к fallback-ключу (слабее PFS
  // первого сообщения). Порог/пачка — OTK_REPLENISH_THRESHOLD/ONE_TIME_BATCH
  async function replenishOneTimePrekeys(connection: GatewayConnection, token: string) {
    const engine = deps.getE2e();
    if (!engine || connection.hasV1 === false) return;
    try {
      const raw = await connection.request(TOPIC_DEVICE_LIST, JSON.stringify({ token }));
      const response = JSON.parse(raw) as {
        ok: boolean;
        devices?: { device_id: string; one_time_available: number }[];
      };
      if (!response.ok) return;
      const own = response.devices?.find((device) => device.device_id === engine.deviceId);
      // Устройства нет в каталоге: identity отверг бандл при входе (аккаунт на
      // v2, устройство ещё не было в журнале устройств) — публикуем заново (T146)
      if (own && own.one_time_available >= OTK_REPLENISH_THRESHOLD) return;
      const payload = engine.buildTopUpPrekeysPayload(token);
      if (!payload) return;
      await engine.flushStorage();
      const published = JSON.parse(
        await connection.request(TOPIC_PREKEYS_PUBLISH, JSON.stringify(payload)),
      ) as { ok?: boolean };
      if (!published.ok) return;
      deps.log(own ? `one-time prekeys пополнены (остаток был ${own.one_time_available})`
        : 'бандл устройства опубликован в каталоге v1 (устройство в журнале v2)');
    } catch (error) {
      deps.log(`пополнение one-time prekeys не удалось: ${String(error)}`);
    }
  }

  // Pre-auth запрос на отдельном коротком соединении (для флоу регистрации,
  // когда постоянной сессии ещё нет)
  async function requestPreAuth<T>(subject: string, payload: unknown): Promise<T> {
    const connection = new GatewayConnection();
    try {
      await connection.connect(getGatewayUrl());
      const raw = await connection.request(subject, JSON.stringify(payload));
      return JSON.parse(raw) as T;
    } finally {
      connection.close();
    }
  }

  // Публичные параметры сервера для экрана входа: домен адресов (ник →
  // ник@домен) и нужна ли почта при регистрации. Старый сервер без топика
  // (или обрыв) — фолбэк по хосту страницы: e2e и dev ходят на localhost, где
  // identity по умолчанию отвечает за домен «local»
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

  // Отдельное короткое соединение — для формы регистрации (сессии ещё нет)
  async function fetchServerInfo(): Promise<ServerInfo> {
    const connection = new GatewayConnection();
    try {
      await connection.connect(getGatewayUrl());
      const info = await requestServerInfo(connection);
      lastServerInfo = info;
      return info;
    } catch (err) {
      deps.log(`server.info недоступен, домен по хосту: ${String(err)}`);
      return fallbackServerInfo();
    } finally {
      connection.close();
    }
  }

  // Последний ответ server.info (логин-соединение или отдельный запрос)
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
    const currentE2e = deps.getE2e();
    sessionGeneration += 1;
    cancelReconnect();
    deps.calls.teardown();
    deps.getConnection()?.close();
    deps.setConnection(undefined);
    deps.setToken('');
    deps.setE2e(undefined);
    deps.setCallIdentityReady(false);
    deps.resetSyncPromise();
    window.clearInterval(syncTimer);
    window.clearInterval(presenceTimer);
    typingClearTimers.forEach((timer) => window.clearTimeout(timer));
    typingClearTimers.clear();
    return currentE2e;
  }

  return {
    connectAndLogin,
    writeTrustSecret: writeTrustSecretAsync,
    registerAccount,
    confirmEmail,
    fetchServerInfo,
    getLastServerInfo,
    fetchRegisterStatus,
    ensureGroupTyping,
    ensurePresence,
    refreshEphemeral,
    showV2Typing,
    showV2Presence,
    connectWithToken,
    replenishDevicePrekeys: replenishOneTimePrekeys,
    rememberDeviceId: writeDeviceIdMirror,
    forgetDeviceId,
    shutdown,
  };
}
