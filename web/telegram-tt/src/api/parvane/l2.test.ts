import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { ApiUpdate } from '../types';
import type { GatewayConnection } from './gateway';
import type { WireStoredMessage } from './wire';

import { PvClient } from '../../lib/parvane-protocol/parvane_protocol';
import { createL2Gate, type L2State, parseL2State } from './v2/l2';
import { createConnectionController } from './connectionController';
import { createMessageController } from './messages';
import { ParvaneStore } from './store';
import { createSyncController } from './sync';

// Режим чата «усиленная приватность» (L2, spec 007 FR-036, правило L2-1):
// в чате с активным режимом typing/presence не шлются и не показываются, своё
// присутствие не публикуется, смена режима — нативное служебное сообщение.

const SELF = 'alice@local';
const PEER = 'bob@local';
const OTHER = 'carol@local';

const gateway = vi.hoisted(() => {
  class FakeGateway {
    authorize() {
      return SELF;
    }

    request(subject: string) {
      return Promise.resolve(subject === 'identity.server.info' ? JSON.stringify({ domain: 'local' }) : '{}');
    }
  }
  return { FakeGateway };
});

vi.mock('./gateway', () => ({
  GatewayConnection: gateway.FakeGateway,
  getGatewayUrl: () => 'ws://test.invalid/ws',
}));
// Языковой пакет тянет за собой весь провайдер — в тесте тексты задаёт стор
vi.mock('../../util/localization', () => ({ getLangStringByKey: () => undefined }));

const localValues = new Map<string, string>();
const testLocalStorage = {
  get length() { return localValues.size; },
  clear: () => localValues.clear(),
  getItem: (key: string) => localValues.get(key),
  key: (index: number) => Array.from(localValues.keys())[index],
  removeItem: (key: string) => localValues.delete(key),
  setItem: (key: string, value: string) => localValues.set(key, String(value)),
};

const ON: L2State = {
  active: true, mine: false, enabledBy: [PEER], pad: true, ephemeralAllowed: false,
};
const OFF: L2State = {
  active: false, mine: false, enabledBy: [], pad: false, ephemeralAllowed: true,
};

type FakeEngine = { states?: Record<string, L2State>; presence?: boolean; isReady: boolean };

function makeGate(engine: FakeEngine) {
  return createL2Gate({
    getSelf: () => SELF,
    readEngine: (address) => (engine.isReady ? engine.states?.[address] || OFF : undefined),
    readEnginePresence: () => (engine.isReady ? engine.presence ?? true : undefined),
  });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', testLocalStorage);
  localStorage.clear();
});

describe('L2: состояние режима по движку', () => {
  it('разбирает JSON `l2Direct` настоящего движка: режим выключен, эфемерные каналы разрешены', () => {
    const client = new PvClient(SELF, 'device-a', 'local');
    try {
      expect(parseL2State(client.l2Direct(PEER))).toEqual(OFF);
      expect(client.presenceAllowed()).toBe(true);
    } finally {
      client.free();
    }
  });

  it('битый JSON — состояние неизвестно; отсутствующее поле не запрещает эфемерные каналы', () => {
    expect(parseL2State('не json')).toBeUndefined();
    expect(parseL2State('{"active":true}')).toEqual({
      active: true, mine: false, enabledBy: [], pad: false, ephemeralAllowed: true,
    });
  });
});

describe('L2-1: решение для typing/presence (v2/l2.ts)', () => {
  it('активный режим закрывает эфемерные каналы чата и присутствие аккаунта', () => {
    const gate = makeGate({ isReady: true, states: { [PEER]: ON }, presence: false });
    expect(gate.ephemeralAllowed(PEER)).toBe(false);
    expect(gate.ephemeralAllowed(OTHER)).toBe(true);
    expect(gate.presenceAllowed()).toBe(false);
  });

  it('режим, известный с прошлого запуска, действует до готовности движка', () => {
    const engine: FakeEngine = { isReady: true, states: { [PEER]: ON }, presence: false };
    makeGate(engine).state(PEER);
    // Новый запуск: движок ещё не поднят — решает память
    engine.isReady = false;
    const gate = makeGate(engine);
    expect(gate.ephemeralAllowed(PEER)).toBe(false);
    expect(gate.ephemeralAllowed(OTHER)).toBe(true);
    expect(gate.presenceAllowed()).toBe(false);
    // Движок поднялся, режим за это время сняли — сверка возвращает изменившийся чат
    engine.isReady = true;
    engine.states = {};
    engine.presence = true;
    expect(gate.reconcile([])).toEqual([PEER]);
    expect(gate.ephemeralAllowed(PEER)).toBe(true);
    expect(gate.presenceAllowed()).toBe(true);
  });

  it('политика группы: первое знакомство без режима — не изменение, смена — один раз', () => {
    const gate = makeGate({ isReady: true });
    expect(gate.noteGroupPolicy('v2g:aa', false)).toBe(false);
    expect(gate.noteGroupPolicy('v2g:aa', true)).toBe(true);
    // После перезагрузки то же значение служебное сообщение не повторяет
    expect(makeGate({ isReady: true }).noteGroupPolicy('v2g:aa', true)).toBe(false);
    expect(gate.noteGroupPolicy('v2g:aa', false)).toBe(true);
    // Первое знакомство с группой, где режим уже включён, — сообщение
    expect(gate.noteGroupPolicy('v2g:bb', true)).toBe(true);
    // Покинутая группа забыта: память не держит присутствие закрытым
    makeGate({ isReady: true, states: { 'v2g:bb': ON } }).state('v2g:bb');
    gate.forget('v2g:bb');
    expect(makeGate({ isReady: false }).presenceAllowed()).toBe(true);
  });
});

describe('L2-1: typing и presence (connectionController, эфемерные каналы v2)', () => {
  let blocked: Set<string>;
  let isPresenceAllowed: boolean;
  let store: ParvaneStore;
  let updates: ApiUpdate[];
  let published: number;
  let watched: string[];
  let controller: ReturnType<typeof createConnectionController>;

  async function login() {
    let connection: GatewayConnection | undefined;
    let token = '';
    updates = [];
    published = 0;
    watched = [];
    store = new ParvaneStore();
    controller = createConnectionController({
      calls: { teardown: () => undefined, setup: () => undefined } as never,
      getConnection: () => connection,
      setConnection: (next) => { connection = next; },
      getStore: () => store,
      setStore: (next) => { store = next; },
      getToken: () => token,
      setToken: (next) => { token = next; },
      setCallIdentityReady: () => undefined,
      polls: { setSelf: () => undefined, setPeerIdResolver: () => undefined } as never,
      taskOffers: { setSelf: () => undefined, setPeerIdResolver: () => undefined } as never,
      onNewSession: () => undefined,
      resetSyncPromise: () => undefined,
      resolveDisplayNames: () => Promise.resolve(),
      selfId: () => store.getIdForAddress(store.self),
      sendUpdate: (update) => { updates.push(update); },
      log: () => undefined,
      v2: {
        ephemeralAllowed: (address) => !blocked.has(address),
        presenceAllowed: () => isPresenceAllowed,
        publishPresence: () => { published += 1; },
        watchPresence: (address) => { watched.push(address); },
      },
    });
    await controller.connectWithToken(SELF, 'jwt');
    updates.length = 0;
  }

  const typingUpdates = () => updates.filter((update) => update['@type'] === 'updateChatTypingStatus');
  const onlineUpdates = () => updates.filter((update) => (
    update['@type'] === 'updateUserStatus' && update.status.type === 'userStatusOnline'
  ));

  beforeEach(() => {
    blocked = new Set();
    isPresenceAllowed = true;
  });

  afterEach(() => {
    controller.shutdown();
  });

  it('своё присутствие не публикуется, пока режим активен хотя бы в одном чате', async () => {
    isPresenceAllowed = false;
    blocked.add(PEER);
    await login();
    expect(published).toBe(0);
    // Режим сняли — присутствие публикуется сразу
    isPresenceAllowed = true;
    blocked.clear();
    controller.refreshEphemeral(PEER);
    expect(published).toBe(1);
  });

  it('без режима присутствие публикуется при входе', async () => {
    await login();
    expect(published).toBe(1);
  });

  it('входящий typing L2-чата игнорируется, обычного — показывается', async () => {
    blocked.add(PEER);
    await login();
    controller.showV2Typing(PEER, PEER);
    expect(typingUpdates()).toHaveLength(0);
    controller.showV2Typing(OTHER, OTHER);
    expect(typingUpdates()).toHaveLength(1);
  });

  it('presence собеседника L2-чата не слушаем и «в сети» не показываем', async () => {
    blocked.add(PEER);
    await login();
    const peerId = store.getIdForAddress(PEER);
    const otherId = store.getIdForAddress(OTHER);
    controller.ensurePresence(peerId);
    controller.ensurePresence(otherId);
    expect(watched).toEqual([OTHER]);

    // Режим включили у уже слушаемого собеседника: кадр presence гасится,
    // показанный статус «в сети» снимается
    controller.showV2Presence(OTHER);
    expect(onlineUpdates()).toHaveLength(1);
    blocked.add(OTHER);
    controller.refreshEphemeral(OTHER);
    expect(updates).toContainEqual({
      '@type': 'updateUserStatus', userId: otherId, status: { type: 'userStatusRecently' },
    });
    controller.showV2Presence(OTHER);
    expect(onlineUpdates()).toHaveLength(1);

    // Режим выключили — присутствие собеседника слушается
    blocked.delete(PEER);
    controller.refreshEphemeral(PEER);
    expect(watched).toEqual([OTHER, PEER]);
  });
});

describe('L2-1: исходящий typing (messages.ts)', () => {
  it('в чат с активным режимом typing не уходит; в остальные — только эфемерным каналом v2', async () => {
    const store = new ParvaneStore();
    store.self = SELF;
    const blocked = new Set([PEER]);
    const connection = new gateway.FakeGateway() as unknown as GatewayConnection;
    const sentV2: string[] = [];
    const controller = createMessageController({
      getConnection: () => connection,
      getStore: () => store,
      getToken: () => 'jwt',
      v2: {
        ephemeralAllowed: (address: string) => !blocked.has(address),
        isV2GroupAddress: () => false,
        trySendTyping: (address: string) => {
          sentV2.push(address);
          // Сбой канала не понижает ни к чему — «печатает» просто не уходит (TYPING-1)
          return address === OTHER ? Promise.resolve(true) : Promise.reject(new Error('v2 unavailable'));
        },
      },
    } as never);
    const peerId = store.getIdForAddress(PEER);
    const otherId = store.getIdForAddress(OTHER);
    await controller.methods.sendMessageAction({ peer: { id: peerId }, action: { type: 'typing' } });
    await controller.methods.sendMessageAction({ peer: { id: otherId }, action: { type: 'typing' } });
    await Promise.resolve();
    expect(sentV2).toEqual([OTHER]);
  });
});

describe('L2: служебное сообщение о смене режима', () => {
  function makeSync() {
    const store = new ParvaneStore();
    store.self = SELF;
    const updates: ApiUpdate[] = [];
    const saved: WireStoredMessage[] = [];
    const sync = createSyncController({
      getConnection: () => undefined,
      getStore: () => store,
      getToken: () => 'jwt',
      groups: { register: () => undefined },
      localState: {
        isBlocked: () => false,
        updateOwnJournalEntry: () => undefined,
        saveHistoryRecord: (stored: WireStoredMessage) => { saved.push(stored); },
        deleteHistoryRecord: () => undefined,
        scheduleTtlDeletion: () => undefined,
        loadReadUuids: () => [],
        flushHistoryNow: () => Promise.resolve(),
      } as never,
      media: { rememberKeys: () => undefined },
      polls: {} as never,
      taskOffers: {} as never,
      refreshPollMessage: () => undefined,
      rememberSavedGif: () => undefined,
      sendUpdate: (update) => { updates.push(update); },
      log: () => undefined,
    });
    const newMessages = () => updates.flatMap((update) => (update['@type'] === 'newMessage' ? [update.message] : []));
    return {
      store, sync, updates, saved, newMessages,
    };
  }

  const chatMode = (id: string, from: string, to: string, l2: boolean): WireStoredMessage => ({
    id, from, to, ts: 1_700_000_000, content: { kind: 'chat_mode', l2 },
  });

  it('стор строит нативное служебное сообщение (customAction) с текстом по ключам локализации', () => {
    const store = new ParvaneStore();
    store.self = SELF;
    store.setDisplayName(PEER, 'Боб');
    const texts: Record<string, string> = {
      ParvaneL2Enabled: '{user} включил(а) усиленную приватность',
      ParvaneL2DisabledYou: 'Вы выключили усиленную приватность',
    };
    store.getLangString = (key) => texts[key];

    const incoming = store.buildApiMessage(chatMode('018f0000-0000-7000-8000-000000000001', PEER, SELF, true));
    expect(incoming.content).toEqual({
      action: { mediaType: 'action', type: 'customAction', message: 'Боб включил(а) усиленную приватность' },
    });
    expect(incoming.isOutgoing).toBe(false);
    expect(incoming.isSilent).toBe(true);
    expect(incoming.chatId).toBe(store.getIdForAddress(PEER));

    const own = store.buildApiMessage(chatMode('018f0000-0000-7000-8000-000000000002', SELF, PEER, false));
    expect(own.content.action).toMatchObject({ type: 'customAction', message: 'Вы выключили усиленную приватность' });
    expect(own.chatId).toBe(store.getIdForAddress(PEER));

    // Языковой пакет ещё не загружен — английский текст по умолчанию
    store.getLangString = undefined;
    const fallback = store.buildApiMessage(chatMode('018f0000-0000-7000-8000-000000000003', PEER, SELF, false));
    expect(fallback.content.action).toMatchObject({ message: 'Боб disabled enhanced privacy' });
  });

  it('событие v2 идёт обычным конвейером: служебное сообщение в чате, в кэше истории, без непрочитанного', async () => {
    const {
      store, sync, updates, saved, newMessages,
    } = makeSync();
    const stored = chatMode('018f0000-0000-7000-8000-000000000004', PEER, SELF, true);
    await sync.applyExternal(stored);

    const [message] = newMessages();
    expect(message.chatId).toBe(store.getIdForAddress(PEER));
    expect(message.content.action).toMatchObject({ type: 'customAction' });
    expect(message.content.text).toBeUndefined();
    // Переживает перезагрузку: строка с `origin: 'v2'` лежит в кэше истории
    expect(saved).toEqual([{ ...stored, origin: 'v2', order: stored.ts * 1000 }]);
    // Служебное сообщение не остаётся «непрочитанным» на чате
    expect(updates).toContainEqual(expect.objectContaining({
      '@type': 'updateThreadReadState',
      readState: { lastReadInboxMessageId: message.id, unreadCount: 0 },
    }));
    expect(sync.isUnreadIncoming(message.chatId, message)).toBe(false);
  });
});
