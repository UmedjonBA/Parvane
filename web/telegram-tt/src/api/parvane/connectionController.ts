import type { ApiUpdate } from '../types';
import type { createCallController } from './calls';
import type { PollStore } from './polls';

import { E2eEngine } from './e2e';
import { GatewayConnection, getGatewayUrl } from './gateway';
import { ParvaneStore } from './store';
import {
  buildCallInboxTopic,
  buildMsgInboxTopic,
  TOPIC_IDENTITY_ISSUE,
  TOPIC_IDENTITY_REGISTER,
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
  isSynced: () => boolean;
  resetSyncPromise: () => void;
  requestDeltaSync: () => void;
  resolveDisplayNames: (addresses: string[]) => Promise<void>;
  handleInboxFrame: (payload: string) => void;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
};

const DELTA_SYNC_INTERVAL_MS = 10000;
const PRESENCE_INTERVAL_MS = 30000;
const PRESENCE_TTL_SECS = 90;
const TYPING_CLEAR_MS = 6000;
const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 10000;

export function createConnectionController(deps: ConnectionDependencies) {
  let syncTimer: number | undefined;
  let presenceTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let sessionGeneration = 0;
  const typingClearTimers = new Map<string, number>();

  async function issueToken(activeConnection: GatewayConnection, user: string, password: string) {
    const issue = async () => {
      const raw = await activeConnection.request(
        TOPIC_IDENTITY_ISSUE,
        JSON.stringify({ user, password }),
      );
      return JSON.parse(raw) as { ok: boolean; token?: string; error?: string };
    };

    let response = await issue();
    if (!response.ok) {
      const raw = await activeConnection.request(
        TOPIC_IDENTITY_REGISTER,
        JSON.stringify({ user, password, invite: '' }),
      );
      const registration = JSON.parse(raw) as { ok: boolean; error?: string };
      if (registration.ok) response = await issue();
    }
    if (!response.ok || !response.token) {
      throw new Error(response.error || 'identity отказал в выдаче токена');
    }
    return response.token;
  }

  function handleTypingFrame(payload: string) {
    let from: string | undefined;
    try {
      from = (JSON.parse(payload) as { from?: string }).from;
    } catch {
      return;
    }
    const store = deps.getStore();
    if (!from || from === store.self) return;

    const chatId = store.getIdForAddress(from);
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
    deps.calls.setup();
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
      if (deps.isSynced()) deps.requestDeltaSync();
      else deps.resetSyncPromise();
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

  async function connectAndLogin(user: string, password: string) {
    cancelReconnect();
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

      const nextToken = await issueToken(activeConnection, user, password);
      deps.setToken(nextToken);
      deps.log('JWT получен');
      await activeConnection.authorize(nextToken);
      deps.log(`авторизован: ${user}`);

      const store = new ParvaneStore();
      store.self = user;
      deps.setStore(store);
      deps.polls.setSelf(user);
      deps.onNewSession();

      deps.setCallIdentityReady(false);
      try {
        const nextE2e = await E2eEngine.create(user);
        deps.setE2e(nextE2e);
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
    } catch (error) {
      if (generation === sessionGeneration && deps.getConnection() === activeConnection) {
        deps.setConnection(undefined);
        deps.setToken('');
      }
      activeConnection.close();
      throw error;
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

  return { connectAndLogin, shutdown };
}
