import type { ApiMessage, ApiUpdate } from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import {
  CallEngine, type CallMedia, FALLBACK_ICE_SERVERS, type WireCallSignal,
} from './callengine';
import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import {
  GROUP_CALL_MAX_PARTICIPANTS, GroupCallEngine, type GroupPeerState, type WireGroupInvite,
} from './groupcall';
import {
  buildWireEvent,
  TOPIC_CALL_HISTORY_REQUEST,
  TOPIC_CALL_ICE_REQUEST,
  TOPIC_CALL_SIGNAL,
  TOPIC_IDENTITY_RESOLVE,
  type WireCallRecord,
  type WireEvent,
  type WireIceServer,
  type WireUserInfo,
} from './wire';

type CallDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  isIdentityReady: () => boolean;
  isBlocked: (address: string) => boolean;
  sendUpdate: (update: ApiUpdate) => void;
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
// Сколько показывать «занято» перед закрытием оверлея
const BUSY_OVERLAY_MS = 2500;

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

  function getIceTransportPolicy(): RTCIceTransportPolicy | undefined {
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
      senderId: isOutgoing ? store.getIdForAddress(store.self) : chatId,
    };
  }

  async function syncHistory() {
    const connection = deps.getConnection();
    if (!connection) return;
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
    // Сервер отдаёт новые первыми; вставляем старые первыми и только терминальные
    for (const record of records.reverse()) {
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
    }
  }

  function scheduleHistorySync(delayMs: number) {
    window.setTimeout(() => {
      void syncHistory();
    }, delayMs);
  }

  async function fetchSigningKey(peer: string) {
    const raw = await deps.getConnection()!.request(
      TOPIC_IDENTITY_RESOLVE,
      JSON.stringify({ usernames: [peer] }),
    );
    const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
    return users.find(({ username }) => username === peer)?.pubkey;
  }

  function setup() {
    const callWindow = window as unknown as { parvaneCall?: CallWindowState };
    callWindow.parvaneCall = { state: 'ended' };
    const emit = () => window.dispatchEvent(new CustomEvent('parvane-call'));
    listeners.onState = (state) => {
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
      sendSignal: (to, signal) => {
        const store = deps.getStore();
        const envelope = buildWireEvent(store.self, deps.getToken(), { to, signal });
        deps.getConnection()!.publish(TOPIC_CALL_SIGNAL, JSON.stringify(envelope));
      },
      getPeerSigningKey: fetchSigningKey,
      getIceServers,
      getIceTransportPolicy,
      sign: (data) => identity.signCallData(data),
      verify: (publicKey, data, signature) => identity.verifyCallData(publicKey, data, signature),
      onState: (state) => listeners.onState(state),
      onRemoteStream: (stream) => listeners.onRemoteStream(stream),
      onIncoming: (from, callId, media) => listeners.onIncoming(from, callId, media),
      onSas: (sas) => listeners.onSas(sas),
    });

    groupEngine = new GroupCallEngine(deps.getStore().self, {
      sendSignal: (peer, signal) => {
        const store = deps.getStore();
        // Реальный from (шард сверяет с JWT), gcall:-префикс только в to
        const envelope = buildWireEvent(store.self, deps.getToken(), {
          to: `gcall:${peer}`, signal,
        });
        deps.getConnection()!.publish(TOPIC_CALL_SIGNAL, JSON.stringify(envelope));
      },
      getPeerSigningKey: fetchSigningKey,
      getIceServers,
      getIceTransportPolicy,
      sign: (data) => identity.signCallData(data),
      verify: (publicKey, data, signature) => identity.verifyCallData(publicKey, data, signature),
      onPeerState: (peer, state) => {
        const group = callWindow.parvaneCall!.group;
        if (!group) return;
        group.peerStates = { ...group.peerStates, [peer]: state };
        group.peerNames = { ...group.peerNames, [peer]: deps.getStore().getDisplayName(peer) };
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

  function teardown() {
    try {
      engine?.hangUp();
      groupEngine?.leave();
    } catch (error) {
      deps.log(`Ошибка завершения звонка: ${String(error)}`);
    }
    engine = undefined;
    groupEngine = undefined;
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

  function handleGroupFrame(payload: string) {
    let event: WireEvent<WireCallSignal | WireGroupInvite>;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const signal = event.payload;
    if (!signal?.type || !groupEngine) return;
    if (signal.type === 'group_invite') {
      ensureGroupWindowState(signal.group_call_id, signal.participants);
    }
    void groupEngine.handleSignal(event.from, signal).catch((error) => {
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
      deps.log(
        `Групповой звонок невозможен: участников ${members.length}, лимит ${GROUP_CALL_MAX_PARTICIPANTS}`,
      );
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
    acceptIncoming: () => engine?.acceptIncoming(),
    handleFrame,
    handleGroupFrame,
    hangUp: () => {
      if (groupEngine?.currentGroupCallId) groupEngine.leave();
      else engine?.hangUp();
    },
    placeCall,
    setup,
    teardown,
    toggleCamera,
    toggleMute,
  };
}
