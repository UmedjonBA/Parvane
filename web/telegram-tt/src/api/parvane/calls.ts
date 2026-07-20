import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { CallEngine, type CallMedia, type WireCallSignal } from './callengine';
import {
  buildWireEvent,
  TOPIC_CALL_SIGNAL,
  TOPIC_IDENTITY_RESOLVE,
  type WireEvent,
  type WireUserInfo,
} from './wire';

type CallDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  isIdentityReady: () => boolean;
  log: (message: string) => void;
};

type CallWindowState = {
  state: string;
  incoming?: { from: string; callId: string; media: string };
  remoteStream?: MediaStream;
  peerName?: string;
  sas?: string;
  hasSecurityError?: boolean;
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
      if (state === 'ended' || state === 'security_failed') {
        callWindow.parvaneCall!.incoming = undefined;
        callWindow.parvaneCall!.remoteStream = undefined;
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

  return {
    acceptIncoming: () => engine?.acceptIncoming(),
    handleFrame,
    hangUp: () => engine?.hangUp(),
    placeCall,
    setup,
    teardown,
  };
}
