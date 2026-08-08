import type { ApiMessage, ApiUpdate } from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { CallEngine, type CallMedia, type WireCallSignal } from './callengine';
import {
  buildWireEvent,
  TOPIC_CALL_HISTORY_REQUEST,
  TOPIC_CALL_SIGNAL,
  TOPIC_IDENTITY_RESOLVE,
  type WireCallRecord,
  type WireEvent,
  type WireUserInfo,
} from './wire';

type CallDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  isIdentityReady: () => boolean;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
};

// Даём runFullSync занять младшие message id, чтобы старые звонки не падали
// в самый низ чата
const INITIAL_HISTORY_DELAY_MS = 3000;
// Терминальный статус пишется шардом по hangup/reject — даём ему долететь
const POST_CALL_HISTORY_DELAY_MS = 1500;

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
};

export function createCallController(deps: CallDependencies) {
  let engine: CallEngine | undefined;
  const listeners = {
    onState: (_state: string) => {},
    onRemoteStream: (_stream: MediaStream) => {},
    onLocalStream: (_stream: MediaStream) => {},
    onIncoming: (_from: string, _callId: string, _media: CallMedia) => {},
    onSas: (_sas?: string) => {},
  };

  function buildCallMessage(record: WireCallRecord): ApiMessage | undefined {
    const store = deps.getStore();
    const isOutgoing = record.caller === store.self;
    const peer = isOutgoing ? record.callee : record.caller;
    if (!peer || peer === store.self || store.isGroupAddress(peer)) return undefined;
    const chatId = store.getIdForAddress(peer);
    const id = store.allocateMessageId(chatId, record.call_id);
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
      if (state === 'ended' || state === 'security_failed') {
        callWindow.parvaneCall!.incoming = undefined;
        callWindow.parvaneCall!.remoteStream = undefined;
        callWindow.parvaneCall!.localStream = undefined;
        callWindow.parvaneCall!.isMuted = undefined;
        callWindow.parvaneCall!.isCameraOff = undefined;
        scheduleHistorySync(POST_CALL_HISTORY_DELAY_MS);
      }
      emit();
    };
    listeners.onRemoteStream = (stream) => {
      callWindow.parvaneCall!.remoteStream = stream;
      emit();
    };
    listeners.onIncoming = (from, callId, media) => {
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
      sign: (data) => identity.signCallData(data),
      verify: (publicKey, data, signature) => identity.verifyCallData(publicKey, data, signature),
      onState: (state) => listeners.onState(state),
      onRemoteStream: (stream) => listeners.onRemoteStream(stream),
      onIncoming: (from, callId, media) => listeners.onIncoming(from, callId, media),
      onSas: (sas) => listeners.onSas(sas),
    });
  }

  function teardown() {
    try {
      engine?.hangUp();
    } catch (error) {
      deps.log(`Ошибка завершения звонка: ${String(error)}`);
    }
    engine = undefined;
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

  async function placeCall(chatId: string, isVideo?: boolean) {
    const store = deps.getStore();
    const toAddress = store.getAddressForId(chatId);
    if (!toAddress || !engine || store.isGroupAddress(toAddress)) return undefined;
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
    const tracks = engine?.getLocalStream()?.getAudioTracks() || [];
    if (!tracks.length) return undefined;
    const shouldMute = tracks.some((track) => track.enabled);
    tracks.forEach((track) => {
      track.enabled = !shouldMute;
    });
    emitWindowState({ isMuted: shouldMute });
    return shouldMute;
  }

  function toggleCamera() {
    const tracks = engine?.getLocalStream()?.getVideoTracks() || [];
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
    hangUp: () => engine?.hangUp(),
    placeCall,
    setup,
    teardown,
    toggleCamera,
    toggleMute,
  };
}
