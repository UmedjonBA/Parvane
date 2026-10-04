import type { ApiMessage, ApiUpdate } from '../types';
import type { E2eEngine, WireDeviceBundle } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import {
  CallEngine, type CallMedia, FALLBACK_ICE_SERVERS, RING_TIMEOUT_MS, type WireCallSignal,
} from './callengine';
import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import {
  GROUP_CALL_MAX_PARTICIPANTS, GroupCallEngine, type GroupPeerState, type WireGroupInvite,
} from './groupcall';
import {
  buildGroupCallRoute, buildWireEvent,
  TOPIC_CALL_HISTORY_REQUEST,
  TOPIC_CALL_ICE_REQUEST,
  TOPIC_CALL_SIGNAL,
  TOPIC_IDENTITY_RESOLVE,
  TOPIC_PREKEYS_FETCH,
  type WireCallRecord,
  type WireEvent,
  type WireIceServer,
  type WireUserInfo } from './wire';

type CallDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  isIdentityReady: () => boolean;
  isBlocked: (address: string) => boolean;
  sendUpdate: (update: ApiUpdate) => void;
  // Пересчёт непрочитанного чата после инъекции входящей записи о звонке
  pushReadState: (chatId: string) => void;
  // Протокол v2: сигнал звонка собеседнику с журналом устройств v2 —
  // запечатанным конвертом (true — ушёл по v2; false — идти по v1).
  // `groupCallId` — попарный сигнал внутри группового звонка (T141)
  sendV2Signal?: (
    to: string, signal: WireCallSignal | WireGroupInvite, groupCallId?: string,
  ) => Promise<boolean>;
  // У собеседника на v2 остались v1-устройства (подписанный список LEGACY-1):
  // сигнал личного звонка дублируется им v1-путём, иначе они не зазвонят
  hasLegacyDevices?: (peer: string) => boolean;
  // Завершённый звонок по v2 — в журнал личного состояния: серверной истории у
  // v2-звонков нет (D-08)
  recordV2Call?: (record: WireCallRecord) => void;
  log: (message: string) => void;
};

// Даём runFullSync занять младшие message id, чтобы старые звонки не падали
// в самый низ чата
const INITIAL_HISTORY_DELAY_MS = 3000;
// Терминальный статус пишется шардом по hangup/reject — даём ему долететь
const POST_CALL_HISTORY_DELAY_MS = 1500;
// Обновляем TURN-креды заранее, до истечения срока
const ICE_CACHE_RATIO = 0.8;
// e2e-хук: iceTransportPolicy=relay — соединение возможно только через TURN
const FORCE_RELAY_STORAGE_KEY = 'parvane:e2e:forceRelay';
// e2e-хук: короткий таймаут вызова (пропущенный звонок без 45-с ожидания) —
// только в диаг-сборке, в проде игнорируется
const RING_TIMEOUT_STORAGE_KEY = 'parvane:e2e:ringTimeoutMs';
const RING_TIMEOUT_MIN_MS = 3000;
const ARE_DIAG_HOOKS_ENABLED = import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1';
// Сколько показывать «занято» перед закрытием оверлея
const BUSY_OVERLAY_MS = 2500;
// Сколько групповых звонков держим в «уже отработанных»: больше приглашений в
// окне одного таймаута вызова не бывает
const BUSY_GROUP_CALL_LIMIT = 64;

type CallWindowState = {
  state: string;
  incoming?: { from: string; callId: string; media: string };
  remoteStream?: MediaStream;
  localStream?: MediaStream;
  peerName?: string;
  sas?: string;
  hasSecurityError?: boolean;
  isMuted?: boolean;
  isCameraOff?: boolean;
  // Входящее приглашение в групповой звонок ждёт согласия
  pendingGroup?: boolean;
  // Название группы, если приглашённый в ней состоит: в WireGroupInvite поля
  // с названием нет (провод не меняем), берём из локального стора
  pendingGroupTitle?: string;
  group?: {
    groupCallId: string;
    title: string;
    peerStates: Record<string, GroupPeerState>;
    peerNames: Record<string, string>;
  };
  groupStreams?: Record<string, MediaStream>;
};

export function createCallController(deps: CallDependencies) {
  let engine: CallEngine | undefined;
  let groupEngine: GroupCallEngine | undefined;
  // Приглашение в групповой звонок до решения пользователя: парные сигналы
  // участников копятся, микрофон/камера не запрашиваются (spec 002 US6)
  type PendingGroupInvite = {
    from: string;
    groupCallId: string;
    participants: string[];
    media: CallMedia;
    // `isAuthenticated` — сигнал пришёл по v2 (отправителя проверил движок)
    buffered: Array<{ from: string; signal: WireCallSignal; isAuthenticated?: boolean }>;
    timer?: number;
  };
  let pendingGroupInvite: PendingGroupInvite | undefined;
  // Групповые звонки, приглашение в которые уже отработано (отклонили или были
  // заняты): id → момент, после которого запись протухает. Вечная запись
  // навсегда гасила бы экран входящего для этого звонка — освободившийся
  // пользователь больше не мог быть позван в идущий разговор (FR-062)
  const busyGroupCallIds = new Map<string, { until: number; isBusy: boolean }>();
  const listeners = {
    onState: (_state: string) => {},
    onRemoteStream: (_stream: MediaStream) => {},
    onLocalStream: (_stream: MediaStream) => {},
    onIncoming: (_from: string, _callId: string, _media: CallMedia) => {},
    onSas: (_sas?: string) => {},
  };

  let cachedIceServers: RTCIceServer[] | undefined;
  let iceCacheExpiresAt = 0;

  async function getIceServers(): Promise<RTCIceServer[]> {
    if (cachedIceServers && Date.now() < iceCacheExpiresAt) return cachedIceServers;
    const connection = deps.getConnection();
    if (!connection) return FALLBACK_ICE_SERVERS;
    try {
      const store = deps.getStore();
      const event = buildWireEvent(store.self, deps.getToken(), {});
      const raw = await connection.request(TOPIC_CALL_ICE_REQUEST, JSON.stringify(event));
      const response = JSON.parse(raw) as {
        payload?: { ice_servers?: WireIceServer[]; ttl_secs?: number };
      };
      const servers = (response.payload?.ice_servers || [])
        .filter((server) => server.urls?.length)
        .map((server) => ({
          urls: server.urls,
          username: server.username,
          credential: server.credential,
        }));
      if (!servers.length) return FALLBACK_ICE_SERVERS;
      cachedIceServers = servers;
      iceCacheExpiresAt = Date.now() + (response.payload?.ttl_secs || 600) * 1000 * ICE_CACHE_RATIO;
      deps.log(`ICE-серверы получены: ${servers.map((server) => server.urls.join('|')).join(', ')}`);
      return servers;
    } catch (error) {
      deps.log(`ICE-конфигурация недоступна, фоллбэк на STUN: ${String(error)}`);
      return FALLBACK_ICE_SERVERS;
    }
  }

  function getRingTimeoutMs(): number {
    if (!ARE_DIAG_HOOKS_ENABLED) return RING_TIMEOUT_MS;
    try {
      const value = Number(localStorage.getItem(RING_TIMEOUT_STORAGE_KEY));
      return Number.isFinite(value) && value >= RING_TIMEOUT_MIN_MS && value <= RING_TIMEOUT_MS
        ? value : RING_TIMEOUT_MS;
    } catch {
      return RING_TIMEOUT_MS;
    }
  }

  function getIceTransportPolicy(): RTCIceTransportPolicy | undefined {
    // Тестовое переопределение — только в диаг-сборке: в проде выставленный
    // ключ иначе перевёл бы все звонки в relay-only
    if (!ARE_DIAG_HOOKS_ENABLED) return undefined;
    try {
      return localStorage.getItem(FORCE_RELAY_STORAGE_KEY) ? 'relay' : undefined;
    } catch {
      return undefined;
    }
  }

  function buildCallMessage(record: WireCallRecord): ApiMessage | undefined {
    const store = deps.getStore();
    const isOutgoing = record.caller === store.self;
    const peer = isOutgoing ? record.callee : record.caller;
    if (!peer || peer === store.self || store.isGroupAddress(peer)) return undefined;
    const chatId = store.getIdForAddress(peer);
    const id = store.allocateMessageId(chatId, record.call_id, record.started_at);
    const reason = record.status === 'missed' ? 'missed'
      : record.status === 'rejected' ? 'busy' : 'hangup';
    const duration = record.status === 'ended' && record.ended_at
      ? Math.max(1, record.ended_at - record.started_at)
      : undefined;
    return {
      id,
      chatId,
      content: {
        action: {
          mediaType: 'action',
          type: 'phoneCall',
          callId: record.call_id,
          reason,
          duration,
          isVideo: record.media === 'video' ? true : undefined,
        },
      },
      date: record.started_at,
      isOutgoing,
      // Свои записи без senderId (как свои sealed-сообщения): апдейтер tt
      // считает newMessage «нашим» по senderId === currentUserId, а на старте
      // currentUserId ещё может быть не выставлен — исходящий звонок после
      // reload помечал чат непрочитанным
      senderId: isOutgoing ? undefined : chatId,
    };
  }

  async function syncHistory() {
    const connection = deps.getConnection();
    // Журнал v1-звонков ведёт шард call; без v1 записи о звонках — только из журнала состояния v2
    if (!connection || connection.hasV1 === false) return;
    const store = deps.getStore();
    let records: WireCallRecord[];
    try {
      const event = buildWireEvent(store.self, deps.getToken(), {});
      const raw = await connection.request(TOPIC_CALL_HISTORY_REQUEST, JSON.stringify(event));
      const response = JSON.parse(raw) as { payload?: { calls?: WireCallRecord[] } };
      records = response.payload?.calls || [];
    } catch (error) {
      deps.log(`История звонков недоступна: ${String(error)}`);
      return;
    }
    // Сервер отдаёт новые первыми; вставляем старые первыми
    applyCallRecords(records.reverse());
  }

  /** Записи о звонках (история шарда call или журнал личного состояния) → сообщения чатов. */
  function applyCallRecords(records: WireCallRecord[]) {
    const store = deps.getStore();
    // Только терминальные
    for (const record of records) {
      if (record.is_group) continue;
      if (record.status !== 'ended' && record.status !== 'missed' && record.status !== 'rejected') continue;
      if (store.hasMessage(record.call_id)) continue;
      const message = buildCallMessage(record);
      if (!message) continue;
      const peerAddress = record.caller === store.self ? record.callee : record.caller;
      deps.sendUpdate({
        '@type': 'updateUser', id: message.chatId, user: store.buildApiUser(peerAddress),
      });
      deps.sendUpdate({
        '@type': 'updateChat', id: message.chatId, chat: store.buildApiChatForUser(peerAddress),
      });
      store.putMessage(message);
      deps.sendUpdate({
        '@type': 'newMessage', chatId: message.chatId, id: message.id, message,
      });
      // tt на newMessage с чужим senderId прибавляет +1 к непрочитанному;
      // запись о звонке прочитать нельзя (нет uuid) — возвращаем счётчик
      // к честному значению, иначе бейдж «1» на чате после каждого reload
      if (!message.isOutgoing) deps.pushReadState(message.chatId);
    }
  }

  function scheduleHistorySync(delayMs: number) {
    window.setTimeout(() => {
      void syncHistory();
    }, delayMs);
  }

  async function fetchPrekeyBundle(user: string) {
    const e2eEngine = deps.getE2e();
    const raw = await deps.getConnection()!.request(TOPIC_PREKEYS_FETCH, JSON.stringify({
      token: deps.getToken(), user, known_devices: e2eEngine?.getKnownDeviceIds(user) || [],
    }));
    return JSON.parse(raw) as {
      ok: boolean;
      identity_key?: string;
      signed_prekey?: string;
      one_time?: string;
      devices?: WireDeviceBundle[];
    };
  }

  // Ключи подписи собеседника: pubkey из identity (ключ последнего вошедшего
  // устройства) плюс signing-ключи всех его устройств из каталога prekeys —
  // иначе звонок со второго устройства (телефон) падал на проверке подписи
  async function fetchSigningKeys(peer: string): Promise<string[]> {
    const keys = new Set<string>();
    try {
      const raw = await deps.getConnection()!.request(
        TOPIC_IDENTITY_RESOLVE,
        JSON.stringify({ usernames: [peer] }),
      );
      const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
      const pubkey = users.find(({ username }) => username === peer)?.pubkey;
      if (pubkey) keys.add(pubkey);
    } catch {
      // каталог недоступен — попробуем устройства
    }
    try {
      const deviceKeys = await deps.getE2e()?.getContactSigningKeys(peer, fetchPrekeyBundle);
      deviceKeys?.forEach((key) => keys.add(key));
    } catch {
      // нет списка устройств — остаёмся с identity pubkey
    }
    return Array.from(keys);
  }

  function setup() {
    const callWindow = window as unknown as { parvaneCall?: CallWindowState };
    callWindow.parvaneCall = { state: 'ended' };
    const emit = () => window.dispatchEvent(new CustomEvent('parvane-call'));
    listeners.onState = (state) => {
      noteV2CallState(state);
      callWindow.parvaneCall!.state = state;
      callWindow.parvaneCall!.hasSecurityError = state === 'security_failed';
      callWindow.parvaneCall!.localStream = engine?.getLocalStream();
      if (state === 'ended' || state === 'security_failed' || state === 'busy') {
        callWindow.parvaneCall!.incoming = undefined;
        callWindow.parvaneCall!.remoteStream = undefined;
        callWindow.parvaneCall!.localStream = undefined;
        callWindow.parvaneCall!.isMuted = undefined;
        callWindow.parvaneCall!.isCameraOff = undefined;
        scheduleHistorySync(POST_CALL_HISTORY_DELAY_MS);
      }
      if (state === 'busy') {
        // Показываем «занято» пару секунд, затем закрываем оверлей
        window.setTimeout(() => {
          if (callWindow.parvaneCall?.state === 'busy') {
            callWindow.parvaneCall.state = 'ended';
            emit();
          }
        }, BUSY_OVERLAY_MS);
      }
      emit();
    };
    listeners.onRemoteStream = (stream) => {
      callWindow.parvaneCall!.remoteStream = stream;
      emit();
    };
    listeners.onIncoming = (from, callId, media) => {
      // Звонок от заблокированного контакта: молча отклоняем, не показывая экран
      if (deps.isBlocked(from)) {
        engine?.rejectCall(from, callId);
        return;
      }
      callWindow.parvaneCall!.incoming = { from, callId, media };
      callWindow.parvaneCall!.state = 'incoming';
      callWindow.parvaneCall!.peerName = deps.getStore().getDisplayName(from);
      emit();
    };
    listeners.onSas = (sas) => {
      callWindow.parvaneCall!.sas = sas;
      emit();
    };

    scheduleHistorySync(INITIAL_HISTORY_DELAY_MS);

    const identity = deps.getE2e();
    if (!identity || !deps.isIdentityReady()) {
      engine = undefined;
      return;
    }

    engine = new CallEngine({
      sendSignal: sendDirectSignal,
      getPeerSigningKeys: fetchSigningKeys,
      getIceServers,
      getIceTransportPolicy,
      getRingTimeoutMs,
      isBusy: () => Boolean(groupEngine?.currentGroupCallId || pendingGroupInvite),
      sign: (data) => identity.signCallData(data),
      verify: (publicKey, data, signature) => identity.verifyCallData(publicKey, data, signature),
      onState: (state) => listeners.onState(state),
      onRemoteStream: (stream) => listeners.onRemoteStream(stream),
      onIncoming: (from, callId, media) => listeners.onIncoming(from, callId, media),
      onSas: (sas) => listeners.onSas(sas),
    });

    groupEngine = new GroupCallEngine(deps.getStore().self, {
      sendSignal: sendGroupSignal,
      getPeerSigningKeys: fetchSigningKeys,
      getIceServers,
      getIceTransportPolicy,
      getRingTimeoutMs,
      sign: (data) => identity.signCallData(data),
      verify: (publicKey, data, signature) => identity.verifyCallData(publicKey, data, signature),
      onPeerState: (peer, state) => {
        const group = callWindow.parvaneCall!.group;
        if (!group) return;
        group.peerStates = { ...group.peerStates, [peer]: state };
        group.peerNames = { ...group.peerNames, [peer]: deps.getStore().getDisplayName(peer) };
        // Участник вышел — убрать его поток, иначе в оверлее остаётся плитка с
        // замороженным последним кадром
        const streams = callWindow.parvaneCall!.groupStreams;
        if (state === 'ended' && streams?.[peer]) {
          const { [peer]: removed, ...rest } = streams;
          callWindow.parvaneCall!.groupStreams = rest;
        }
        // Локальный поток появляется асинхронно (getUserMedia) — подхватываем его
        // для превью и кнопки камеры, как только медиа поднялось
        callWindow.parvaneCall!.localStream = groupEngine?.getLocalStream();
        emit();
      },
      onPeerStream: (peer, stream) => {
        callWindow.parvaneCall!.groupStreams = {
          ...callWindow.parvaneCall!.groupStreams, [peer]: stream,
        };
        callWindow.parvaneCall!.localStream = groupEngine?.getLocalStream();
        emit();
      },
      onEnded: () => {
        callWindow.parvaneCall!.group = undefined;
        callWindow.parvaneCall!.groupStreams = undefined;
        callWindow.parvaneCall!.localStream = undefined;
        callWindow.parvaneCall!.isMuted = undefined;
        callWindow.parvaneCall!.isCameraOff = undefined;
        emit();
      },
    });
  }

  // Сигналы личного звонка уходят строго по порядку (оффер раньше кандидатов):
  // выбор пути v2/v1 асинхронный, поэтому — через очередь
  let signalQueue: Promise<void> = Promise.resolve();

  function sendDirectSignal(to: string, signal: WireCallSignal) {
    signalQueue = signalQueue.then(async () => {
      try {
        if (await deps.sendV2Signal?.(to, signal)) {
          if (signal.type === 'invite') trackV2Call(signal.call_id, to, true, signal.media);
          // LEGACY-1: v1-устройствам собеседника — тот же сигнал v1-путём (его
          // v2-устройства повтор с тем же call_id отбрасывают)
          if (!deps.hasLegacyDevices?.(to)) return;
        }
      } catch (error) {
        // Собеседник на v2, а v2 недоступен: по v1 не понижаем (D-13)
        deps.log(`Сигнал звонка по v2 не отправлен: ${String(error)}`);
        if (signal.type === 'invite') abortUnsentCall(error);
        return;
      }
      const connection = deps.getConnection();
      if (!connection) return;
      const store = deps.getStore();
      const envelope = buildWireEvent(store.self, deps.getToken(), { to, signal });
      connection.publish(TOPIC_CALL_SIGNAL, JSON.stringify(envelope));
    });
  }

  // Вызов по v2 не ушёл: звонок не должен висеть «ringing». Сервер принимает
  // сигнал звонка только по ключу доступа адресата (D-08) — его получают после
  // ответа собеседника на сообщение; пользователю говорим об этом прямо
  function abortUnsentCall(error: unknown) {
    try {
      engine?.hangUp();
    } catch (hangUpError) {
      deps.log(`Ошибка завершения звонка: ${String(hangUpError)}`);
    }
    if (typeof window === 'undefined') return;
    const isNotContact = /forbidden/i.test(String(error));
    window.dispatchEvent(new CustomEvent('parvane-call-unavailable', { detail: { isNotContact } }));
  }

  // Сигналы группового звонка одному участнику уходят строго по порядку:
  // выбор пути (v2 — запечатанным конвертом, иначе v1-инбокс `gcall:`) асинхронный
  const groupSignalQueues = new Map<string, Promise<void>>();
  // Попарный звонок mesh → групповой звонок: отказ на оффер шлётся, когда в
  // звонок не вошли и id группового звонка движку неизвестен
  const meshGroupByCall = new Map<string, string>();
  const MESH_CALL_MEMORY = 256;

  function sendGroupSignal(peer: string, signal: WireCallSignal | WireGroupInvite) {
    const groupCallId = signal.type === 'group_invite' ? undefined : (
      groupEngine?.currentGroupCallId || pendingGroupInvite?.groupCallId || meshGroupByCall.get(signal.call_id)
    );
    const queue = (groupSignalQueues.get(peer) || Promise.resolve()).then(async () => {
      try {
        if ((signal.type === 'group_invite' || groupCallId)
          && await deps.sendV2Signal?.(peer, signal, groupCallId)) return;
      } catch (error) {
        // По v2 не ушло — прежним путём: стороны звонка серверу видны, как и у
        // участников на v1 (сами SDP подписаны в обоих случаях)
        deps.log(`Сигнал группового звонка по v2 не отправлен, иду по v1: ${String(error)}`);
      }
      const connection = deps.getConnection();
      if (!connection) return;
      // Реальный from (шард сверяет с JWT), gcall:-префикс только в to
      const envelope = buildWireEvent(deps.getStore().self, deps.getToken(), {
        to: buildGroupCallRoute(peer), signal,
      });
      connection.publish(TOPIC_CALL_SIGNAL, JSON.stringify(envelope));
    });
    groupSignalQueues.set(peer, queue);
  }

  // Сигнал звонка, принятый по v2 (отправитель уже проверен движком):
  // приглашение в групповой звонок и попарные сигналы mesh (`groupCallId`) —
  // в групповой движок, остальное — личный звонок
  function handleV2Signal(from: string, signal: WireCallSignal | WireGroupInvite, groupCallId?: string) {
    if (signal.type === 'group_invite' || groupCallId) {
      if (signal.type === 'invite' && groupCallId) {
        if (meshGroupByCall.size >= MESH_CALL_MEMORY) meshGroupByCall.clear();
        meshGroupByCall.set(signal.call_id, groupCallId);
      }
      handleGroupSignal(from, signal, true);
      return;
    }
    // Блокировку отрабатывает onIncoming (авто-отбой), как и на v1-пути
    if (!engine) return;
    if (signal.type === 'invite' && !engine.currentCallId && !deps.isBlocked(from)) {
      trackV2Call(signal.call_id, from, false, signal.media);
    }
    if (signal.type === 'reject' && v2Call?.callId === signal.call_id) v2Call.isRejected = true;
    void engine.handleSignal(from, signal, true).catch((error) => {
      deps.log(`Ошибка сигналинга звонка (v2): ${String(error)}`);
    });
  }

  function teardown() {
    try {
      engine?.hangUp();
      groupEngine?.leave();
    } catch (error) {
      deps.log(`Ошибка завершения звонка: ${String(error)}`);
    }
    engine = undefined;
    groupEngine = undefined;
    v2Call = undefined;
  }

  // ── звонок по v2: своя запись истории (сервер её не ведёт, D-08) ───────────

  type V2CallTrack = {
    callId: string;
    peer: string;
    isOutgoing: boolean;
    media: CallMedia;
    startedAt: number;
    activeAt?: number;
    isRejected?: boolean;
  };
  let v2Call: V2CallTrack | undefined;

  function trackV2Call(callId: string, peer: string, isOutgoing: boolean, media: CallMedia) {
    v2Call = {
      callId, peer, isOutgoing, media, startedAt: Math.floor(Date.now() / 1000),
    };
  }

  function noteV2CallState(state: string) {
    if (!v2Call) return;
    if (state === 'active') {
      v2Call.activeAt = v2Call.activeAt || Math.floor(Date.now() / 1000);
      return;
    }
    if (state === 'busy') v2Call.isRejected = true;
    if (state !== 'ended' && state !== 'busy' && state !== 'security_failed') return;
    const call = v2Call;
    v2Call = undefined;
    const self = deps.getStore().self;
    const endedAt = Math.floor(Date.now() / 1000);
    const record: WireCallRecord = {
      call_id: call.callId,
      caller: call.isOutgoing ? self : call.peer,
      callee: call.isOutgoing ? call.peer : self,
      media: call.media,
      status: call.activeAt ? 'ended' : call.isRejected ? 'rejected' : 'missed',
      started_at: call.activeAt || call.startedAt,
      ended_at: call.activeAt ? Math.max(endedAt, call.activeAt + 1) : undefined,
    };
    applyCallRecords([record]);
    deps.recordV2Call?.(record);
  }

  function handleFrame(payload: string) {
    let event: WireEvent<WireCallSignal>;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const signal = event.payload;
    if (!signal?.type || !engine) return;
    void engine.handleSignal(event.from, signal).catch((error) => {
      deps.log(`Ошибка сигналинга звонка: ${String(error)}`);
    });
  }

  function ensureGroupWindowState(groupCallId: string, participants: string[], title?: string) {
    const callWindow = (window as unknown as { parvaneCall?: CallWindowState }).parvaneCall;
    if (!callWindow || callWindow.group?.groupCallId === groupCallId) return;
    const store = deps.getStore();
    const others = participants.filter((peer) => peer !== store.self);
    callWindow.group = {
      groupCallId,
      title: title || others.map((peer) => store.getDisplayName(peer)).join(', '),
      peerStates: {},
      peerNames: Object.fromEntries(others.map((peer) => [peer, store.getDisplayName(peer)])),
    };
    window.dispatchEvent(new CustomEvent('parvane-call'));
  }

  function windowCall() {
    return (window as unknown as { parvaneCall?: CallWindowState }).parvaneCall;
  }

  // Запись об отработанном приглашении живёт не дольше таймаута вызова, а
  // «занят» снимается сразу, как только ни личного, ни группового звонка нет:
  // иначе освободившегося участника уже никогда не позвать в идущий звонок
  function pruneSilencedGroupCalls() {
    const now = Date.now();
    const isFree = !engine?.currentCallId && !groupEngine?.currentGroupCallId && !pendingGroupInvite;
    busyGroupCallIds.forEach((entry, id) => {
      if (entry.until <= now || (entry.isBusy && isFree)) busyGroupCallIds.delete(id);
    });
    if (busyGroupCallIds.size > BUSY_GROUP_CALL_LIMIT) {
      // Самые старые записи (Map хранит порядок вставки) уходят первыми
      Array.from(busyGroupCallIds.keys())
        .slice(0, busyGroupCallIds.size - BUSY_GROUP_CALL_LIMIT)
        .forEach((id) => busyGroupCallIds.delete(id));
    }
  }

  function silenceGroupCall(groupCallId: string, reason: 'busy' | 'declined') {
    busyGroupCallIds.set(groupCallId, {
      until: Date.now() + getRingTimeoutMs(), isBusy: reason === 'busy',
    });
    pruneSilencedGroupCalls();
  }

  function isGroupCallSilenced(groupCallId: string) {
    pruneSilencedGroupCalls();
    return busyGroupCallIds.has(groupCallId);
  }

  function clearPendingGroupInvite() {
    if (pendingGroupInvite?.timer) window.clearTimeout(pendingGroupInvite.timer);
    pendingGroupInvite = undefined;
    const callWindow = windowCall();
    if (callWindow?.pendingGroup) {
      callWindow.pendingGroup = undefined;
      callWindow.pendingGroupTitle = undefined;
      callWindow.incoming = undefined;
      callWindow.state = 'ended';
    }
  }

  function declineGroupInvite() {
    const pending = pendingGroupInvite;
    if (!pending || !groupEngine) return;
    pending.buffered.forEach(({ from, signal }) => {
      if (signal.type === 'invite') groupEngine!.rejectInvite(from, signal.call_id, 'declined');
    });
    // Оффер в mesh шлёт лексикографически меньший адрес, поэтому участникам с
    // бóльшим адресом парного invite от них нет и буфер по ним пуст. Доставить
    // им отказ нечем: call-шард форвардит reject только по известному call_id,
    // а запись звонка создаёт лишь подписанный invite (group_invite записи не
    // заводит) — reject с локально выделенным id шард отбрасывает
    // («неизвестный call_id»). Их строка о нас закрывается по таймауту
    // соединения MeshPeerSession (contracts/calls-consent-and-test-hooks.md);
    // мгновенный отказ здесь требует правки шарда
    silenceGroupCall(pending.groupCallId, 'declined');
    clearPendingGroupInvite();
    window.dispatchEvent(new CustomEvent('parvane-call'));
  }

  async function acceptGroupInvite() {
    const pending = pendingGroupInvite;
    if (!pending || !groupEngine) return;
    // Доступ к устройствам выясняем ДО того, как снять экран согласия: иначе
    // отказавший в доступе успевает увидеть «звонок», и лишь потом все строки
    // гаснут. Поток всё равно понадобится каждой парной сессии, так что
    // запрос не лишний — только переставлен вперёд
    const stream = await groupEngine.ensureLocalStream(pending.media);
    // Пока ждали разрешения, вызов могли отклонить, он мог истечь по таймауту
    // или его снял инициатор
    if (pendingGroupInvite !== pending) return;
    if (!stream) {
      window.dispatchEvent(new CustomEvent('parvane-call-media-error'));
      declineGroupInvite();
      return;
    }
    clearPendingGroupInvite();
    ensureGroupWindowState(pending.groupCallId, pending.participants);
    groupEngine.joinMesh(pending.groupCallId, pending.participants, pending.media);
    pending.buffered.forEach(({ from, signal, isAuthenticated }) => {
      void groupEngine?.handleSignal(from, signal, isAuthenticated).catch((error) => {
        deps.log(`Ошибка группового сигналинга: ${String(error)}`);
      });
    });
  }

  // Приглашение несёт только адреса участников, поэтому группу ищем среди
  // известных клиенту: подходит та, чьи живые участники покрывают весь список;
  // при нескольких совпадениях берём самую тесную. Неизвестна — undefined,
  // и экран падает на перечисление имён
  function findGroupTitleForParticipants(participants: string[]): string | undefined {
    const store = deps.getStore();
    let best: { title: string; size: number } | undefined;
    store.getGroupAddresses().forEach((address) => {
      const info = store.getGroupInfo(address);
      if (!info) return;
      const active = info.members.filter(({ role }) => role !== 'banned').map(({ address: peer }) => peer);
      if (!participants.every((peer) => active.includes(peer))) return;
      if (!best || active.length < best.size) best = { title: info.name, size: active.length };
    });
    return best?.title;
  }

  function startPendingGroupInvite(from: string, invite: WireGroupInvite) {
    const store = deps.getStore();
    const callWindow = windowCall();
    if (!callWindow) return;
    pendingGroupInvite = {
      from,
      groupCallId: invite.group_call_id,
      participants: invite.participants,
      media: invite.media || 'audio',
      buffered: [],
    };
    pendingGroupInvite.timer = window.setTimeout(() => {
      if (pendingGroupInvite?.groupCallId === invite.group_call_id) declineGroupInvite();
    }, getRingTimeoutMs());
    const others = invite.participants.filter((peer) => peer !== store.self);
    callWindow.pendingGroup = true;
    callWindow.pendingGroupTitle = findGroupTitleForParticipants(invite.participants);
    callWindow.incoming = { from, callId: invite.group_call_id, media: invite.media };
    callWindow.peerName = others.map((peer) => store.getDisplayName(peer)).join(', ');
    callWindow.state = 'incoming';
    window.dispatchEvent(new CustomEvent('parvane-call'));
  }

  function handleGroupFrame(payload: string) {
    let event: WireEvent<WireCallSignal | WireGroupInvite>;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const signal = event.payload;
    if (!signal?.type) return;
    handleGroupSignal(event.from, signal, false);
  }

  // `isAuthenticated` — сигнал пришёл по v2: подписи SDP в нём нет, отправителя
  // проверил движок. С v1-шины флаг не передаётся никогда
  function handleGroupSignal(from: string, signal: WireCallSignal | WireGroupInvite, isAuthenticated: boolean) {
    if (!groupEngine) return;
    if (signal.type === 'group_invite') {
      // Приглашение от заблокированного контакта: молча игнорируем, как и
      // личный вызов (listeners.onIncoming) — иначе заблокированный по-прежнему
      // может заставить клиент звонить, начав групповой звонок
      if (deps.isBlocked(from)) return;
      if (groupEngine.currentGroupCallId === signal.group_call_id) {
        void groupEngine.handleSignal(from, signal);
        return;
      }
      // Уже в звонке или уже ждём решения по другому приглашению — «занят»
      if (engine?.currentCallId || groupEngine.currentGroupCallId || pendingGroupInvite) {
        if (pendingGroupInvite?.groupCallId !== signal.group_call_id) {
          silenceGroupCall(signal.group_call_id, 'busy');
        }
        return;
      }
      if (isGroupCallSilenced(signal.group_call_id)) return;
      startPendingGroupInvite(from, signal);
      return;
    }
    // Парные сигналы участников до решения пользователя — в буфер
    if (pendingGroupInvite && pendingGroupInvite.participants.includes(from)) {
      if (signal.type === 'hangup') {
        pendingGroupInvite.buffered = pendingGroupInvite.buffered
          .filter((entry) => !(entry.from === from && entry.signal.type !== 'hangup'
            && 'call_id' in entry.signal && entry.signal.call_id === signal.call_id));
        // Инициатор ушёл — приглашение больше не актуально
        if (from === pendingGroupInvite.from && !pendingGroupInvite.buffered.some((entry) => entry.from === from)) {
          clearPendingGroupInvite();
          window.dispatchEvent(new CustomEvent('parvane-call'));
        }
        return;
      }
      pendingGroupInvite.buffered.push({ from, signal, isAuthenticated });
      return;
    }
    // Не в этом звонке (личный разговор / отклонили) — парный invite отбиваем
    if (signal.type === 'invite' && !groupEngine.currentGroupCallId) {
      groupEngine.rejectInvite(from, signal.call_id, 'busy');
      return;
    }
    void groupEngine.handleSignal(from, signal, isAuthenticated).catch((error) => {
      deps.log(`Ошибка группового сигналинга: ${String(error)}`);
    });
  }

  function placeGroupCall(groupAddress: string, isVideo?: boolean) {
    if (!groupEngine) return undefined;
    const store = deps.getStore();
    const info = store.getGroupInfo(groupAddress);
    if (!info) return undefined;
    const members = getActiveGroupMemberAddresses(info.members);
    if (members.length > GROUP_CALL_MAX_PARTICIPANTS) {
      // Молчаливого отказа быть не должно: раньше кнопка «Call» в большой
      // группе просто ничего не делала — результат метода выбрасывается
      // вызывающим (`void callApi(...)`), поэтому сообщаем событием
      deps.log(
        `Групповой звонок невозможен: участников ${members.length}, лимит ${GROUP_CALL_MAX_PARTICIPANTS}`,
      );
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('parvane-call-too-many', {
          detail: { limit: GROUP_CALL_MAX_PARTICIPANTS },
        }));
      }
      return undefined;
    }
    const groupCallId = crypto.randomUUID();
    ensureGroupWindowState(groupCallId, members, info.name);
    groupEngine.startCall(groupCallId, members, isVideo ? 'video' : 'audio');
    return true;
  }

  async function placeCall(chatId: string, isVideo?: boolean) {
    const store = deps.getStore();
    const toAddress = store.getAddressForId(chatId);
    if (!toAddress || !engine) return undefined;
    // Уже в звонке — повторный вызов затёр бы состояние движка
    if (engine.currentCallId || groupEngine?.currentGroupCallId) return undefined;
    if (store.isGroupAddress(toAddress)) return placeGroupCall(toAddress, isVideo);
    const callState = (window as unknown as { parvaneCall?: CallWindowState }).parvaneCall!;
    callState.peerName = store.getDisplayName(toAddress);
    await engine.placeCall(toAddress, isVideo ? 'video' : 'audio');
    return true;
  }

  function emitWindowState(patch: Partial<CallWindowState>) {
    const callWindow = window as unknown as { parvaneCall?: CallWindowState };
    if (!callWindow.parvaneCall) return;
    Object.assign(callWindow.parvaneCall, patch);
    window.dispatchEvent(new CustomEvent('parvane-call'));
  }

  function toggleMute() {
    const stream = groupEngine?.currentGroupCallId
      ? groupEngine.getLocalStream()
      : engine?.getLocalStream();
    const tracks = stream?.getAudioTracks() || [];
    if (!tracks.length) return undefined;
    const shouldMute = tracks.some((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = !shouldMute;
    });
    emitWindowState({ isMuted: shouldMute });
    return shouldMute;
  }

  function toggleCamera() {
    // В mesh камеру гасим через track.enabled (без ренеготиации): пиры видят
    // застывший/пустой кадр, звук не трогаем
    const stream = groupEngine?.currentGroupCallId
      ? groupEngine.getLocalStream()
      : engine?.getLocalStream();
    const tracks = stream?.getVideoTracks() || [];
    if (!tracks.length) return undefined;
    const shouldDisable = tracks.some((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = !shouldDisable;
    });
    emitWindowState({ isCameraOff: shouldDisable });
    return shouldDisable;
  }

  return {
    applyCallRecords,
    acceptIncoming: () => {
      if (pendingGroupInvite) return acceptGroupInvite();
      return engine?.acceptIncoming();
    },
    handleFrame,
    handleGroupFrame,
    handleV2Signal,
    hangUp: () => {
      if (pendingGroupInvite) declineGroupInvite();
      else if (groupEngine?.currentGroupCallId) groupEngine.leave();
      else {
        // Входящий по v2, сброшенный без ответа, — «отклонён», а не «пропущен»
        if (v2Call && !v2Call.isOutgoing && !v2Call.activeAt) v2Call.isRejected = true;
        engine?.hangUp();
      }
    },
    placeCall,
    setup,
    teardown,
    toggleCamera,
    toggleMute,
  };
}
