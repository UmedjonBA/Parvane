import type { ApiUpdate } from '../types';
import type { createCallController } from './calls';
import type { PollStore } from './polls';

import { E2eEngine } from './e2e';
import { GatewayConnection, getGatewayUrl } from './gateway';
import { ParvaneStore } from './store';
import {
  buildCallInboxTopic,
  buildMsgInboxTopic,
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

  function deviceMirrorKey(user: string) {
    return `parvane:device:${user}`;
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

  // `implicitRegister` — сервер без подтверждения (dev/e2e): неизвестный ник
  // регистрируется прямо при входе. С подтверждением (почта/Telegram) вход
  // только для существующих аккаунтов — иначе опечатка в нике заводила бы
  // pending-аккаунт и вела на экран подтверждения чужого ника
  async function issueToken(
    activeConnection: GatewayConnection, user: string, password: string, implicitRegister: boolean,
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
        JSON.stringify({ user, password, device_id: deviceId || undefined }),
      );
      return JSON.parse(raw) as { ok: boolean; token?: string; error?: string };
    };

    let response = await issue();
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

    // Групповой typing: печатает участник — показываем в групповом чате (по
    // `to`). Личный: показываем в 1-1 чате собеседника (по `from`)
    const chatId = to && store.isGroupAddress(to)
      ? store.getIdForAddress(to, 'group')
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
    deps.sendUpdate({
      '@type': 'updateUserStatus',
      userId: store.getIdForAddress(from),
      status: { type: 'userStatusOnline', expires: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECS },
    });
  }

  function activate(activeConnection: GatewayConnection, user: string, generation: number) {
    deps.setConnection(activeConnection);
    activeConnection.onClose = () => handleClose(activeConnection, user, generation);
    activeConnection.subscribe(buildMsgInboxTopic(user), deps.handleInboxFrame);
    activeConnection.subscribe(`msg.typing.${deps.selfId()}`, handleTypingFrame);
    activeConnection.subscribe('presence.*', handlePresenceFrame);
    activeConnection.subscribe(buildCallInboxTopic(user), deps.calls.handleFrame);
    activeConnection.subscribe(buildCallInboxTopic(`gcall:${user}`), deps.calls.handleGroupFrame);
    // Переустанавливаем подписки на typing-топики известных групп
    subscribedTypingGroups.forEach((groupChatId) => {
      activeConnection.subscribe(`msg.typing.${groupChatId}`, handleTypingFrame);
    });
    deps.calls.setup();
  }

  // Подписка на групповой typing-топик (идемпотентно). Вызывается при
  // регистрации группы; на reconnect переустанавливается в `activate`
  function ensureGroupTyping(groupChatId: string) {
    if (!groupChatId || subscribedTypingGroups.has(groupChatId)) return;
    subscribedTypingGroups.add(groupChatId);
    deps.getConnection()?.subscribe(`msg.typing.${groupChatId}`, handleTypingFrame);
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
    try {
      connection.publish(`presence.${deps.selfId()}`, JSON.stringify({ from: deps.getStore().self }));
    } catch {
      // onClose запустит reconnect; presence будет опубликован после auth.
    }
  }

  // `input` — ник или полный адрес; голый ник дополняется доменом сервера
  // (server.info запрашивается на этом же соединении — лишних сокетов нет).
  // Возвращает полный адрес аккаунта
  async function connectAndLogin(input: string, password: string): Promise<string> {
    cancelReconnect();
    // Новая сессия — состав групп (и их typing-подписки) будет пересобран синком
    subscribedTypingGroups.clear();
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

      const nextToken = await issueToken(activeConnection, user, password, info.confirm === 'none');
      deps.setToken(nextToken);
      deps.log('JWT получен');
      await activeConnection.authorize(nextToken);
      deps.log(`авторизован: ${user}`);

      const store = new ParvaneStore();
      store.self = user;
      deps.setStore(store);
      deps.polls.setSelf(user);
      deps.polls.setPeerIdResolver((address) => deps.getStore().getIdForAddress(address));
      deps.onNewSession();

      deps.setCallIdentityReady(false);
      try {
        const nextE2e = await E2eEngine.create(user, readDeviceIdMirror(user));
        deps.setE2e(nextE2e);
        writeDeviceIdMirror(user, nextE2e.deviceId);
        const prekeys = nextE2e.buildPrekeysPayload(nextToken);
        if (prekeys) {
          await nextE2e.flushStorage();
          await activeConnection.request(TOPIC_PREKEYS_PUBLISH, JSON.stringify(prekeys));
          deps.log('E2E готов, прекеи опубликованы');
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

      const nextE2e = deps.getE2e();
      if (nextE2e) {
        try {
          const raw = await activeConnection.request(TOPIC_IDENTITY_SETKEY, JSON.stringify({
            token: nextToken,
            pubkey: nextE2e.signingKey,
          }));
          const response = JSON.parse(raw) as { ok?: boolean; error?: string };
          if (!response.ok) throw new Error(response.error || 'Call identity key registration failed');
          deps.setCallIdentityReady(true);
        } catch (error) {
          deps.log(`Ключ аутентификации звонков не зарегистрирован: ${String(error)}`);
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
    if (!engine) return;
    try {
      const raw = await connection.request(TOPIC_DEVICE_LIST, JSON.stringify({ token }));
      const response = JSON.parse(raw) as {
        ok: boolean;
        devices?: { device_id: string; one_time_available: number }[];
      };
      if (!response.ok) return;
      const own = response.devices?.find((device) => device.device_id === engine.deviceId);
      if (!own || own.one_time_available >= OTK_REPLENISH_THRESHOLD) return;
      const payload = engine.buildTopUpPrekeysPayload(token);
      if (!payload) return;
      await engine.flushStorage();
      await connection.request(TOPIC_PREKEYS_PUBLISH, JSON.stringify(payload));
      deps.log(`one-time prekeys пополнены (остаток был ${own.one_time_available})`);
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
    registerAccount,
    confirmEmail,
    fetchServerInfo,
    getLastServerInfo,
    fetchRegisterStatus,
    ensureGroupTyping,
    shutdown,
  };
}
