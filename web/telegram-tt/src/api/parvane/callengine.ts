// Звонки: WebRTC P2P (RTCPeerConnection) + сигналинг через шину Parvane.
// Медиа-поток идёт напрямую между пирами (мимо сервера); сервер только релеит
// SDP/ICE через call.signal → call.user.<to>. Wire-совместимо с десктопом:
// CallSignal Invite/Answer/Ice/Hangup/Reject.

export type CallMedia = 'audio' | 'video';

export type WireCallSignal =
  | { type: 'invite'; call_id: string; media: CallMedia; sdp: string; sig?: string }
  | { type: 'answer'; call_id: string; sdp: string; sig?: string }
  | { type: 'reject'; call_id: string; reason?: string }
  | { type: 'ice'; call_id: string; candidate: string }
  | { type: 'hangup'; call_id: string };

export type CallState = 'requesting' | 'ringing' | 'connecting' | 'active' | 'security_failed' | 'ended';

type CallCallbacks = {
  sendSignal: (to: string, signal: WireCallSignal) => void;
  getPeerSigningKey: (peer: string) => Promise<string | undefined>;
  // ICE-конфигурация с сервера (STUN + краткоживущие TURN-креды); при
  // недоступности возвращает фоллбэк
  getIceServers: () => Promise<RTCIceServer[]>;
  getIceTransportPolicy: () => RTCIceTransportPolicy | undefined;
  sign: (data: string) => string;
  verify: (publicKey: string, data: string, signature: string) => boolean;
  onState: (state: CallState) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onIncoming: (from: string, callId: string, media: CallMedia) => void;
  onSas: (sas?: string) => void;
};

export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

const SAS_EMOJI = [
  '🐱', '🐶', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯',
  '🐸', '🐵', '🦉', '🦄', '🐝', '🦋', '🌺', '🌈',
  '🍎', '🍊', '🍋', '🍉', '🍇', '🍓', '🥝', '🍑',
  '🎸', '🎹', '🎺', '🥁', '🎨', '🎲', '🚀', '⚓',
];

export class CallEngine {
  private pc?: RTCPeerConnection;

  private localStream?: MediaStream;

  private callId?: string;

  private peer?: string;

  private peerSigningKey?: string;

  private isCaller = false;

  private isAwaitingAcceptance = false;

  private seenCallIds = new Set<string>();

  private pendingCandidates: RTCIceCandidateInit[] = [];

  private remoteReady = false;

  constructor(private cb: CallCallbacks) {}

  get currentCallId() {
    return this.callId;
  }

  get currentPeer() {
    return this.peer;
  }

  async placeCall(peer: string, media: CallMedia) {
    const callId = crypto.randomUUID();
    this.callId = callId;
    this.peer = peer;
    this.isCaller = true;
    this.rememberCallId(callId);
    this.cb.onSas(undefined);
    this.cb.onState('requesting');

    try {
      if (!await this.loadPeerSigningKey(peer, callId)) {
        if (this.isCurrentCall(peer, callId)) this.failSecurity();
        return;
      }
      if (!await this.setupPeerConnection(media, callId)) return;
      const pc = this.pc!;
      const offer = await pc.createOffer();
      if (!this.isCurrentConnection(peer, callId, pc)) return;
      await pc.setLocalDescription(offer);
      if (!this.isCurrentConnection(peer, callId, pc)) return;
      const sdp = offer.sdp || '';
      const signature = this.signSdp(sdp);
      if (!signature) {
        this.failSecurity();
        return;
      }
      this.cb.sendSignal(peer, {
        type: 'invite', call_id: callId, media, sdp, sig: signature,
      });
      this.cb.onState('ringing');
    } catch {
      if (this.isCurrentCall(peer, callId)) this.endAfterMediaFailure();
    }
  }

  async acceptCall(from: string, callId: string, media: CallMedia, offerSdp: string) {
    this.callId = callId;
    this.peer = from;
    this.isCaller = false;
    this.isAwaitingAcceptance = false;
    this.cb.onState('connecting');

    try {
      if (!await this.setupPeerConnection(media, callId)) return;
      const pc = this.pc!;
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      if (!this.isCurrentConnection(from, callId, pc)) return;
      this.remoteReady = true;
      this.flushCandidates();

      const answer = await pc.createAnswer();
      if (!this.isCurrentConnection(from, callId, pc)) return;
      await pc.setLocalDescription(answer);
      if (!this.isCurrentConnection(from, callId, pc)) return;
      const sdp = answer.sdp || '';
      const signature = this.signSdp(sdp);
      if (!signature) {
        this.failSecurity('reject');
        return;
      }
      this.cb.sendSignal(from, { type: 'answer', call_id: callId, sdp, sig: signature });
      await this.emitSas(callId);
    } catch {
      if (this.isCurrentCall(from, callId)) this.endAfterMediaFailure('reject');
    }
  }

  rejectCall(from: string, callId: string) {
    try {
      this.cb.sendSignal(from, { type: 'reject', call_id: callId });
    } finally {
      if (callId === this.callId && from === this.peer) {
        this.cleanup();
        this.cb.onState('ended');
      }
    }
  }

  hangUp() {
    try {
      if (this.peer && this.callId) {
        this.cb.sendSignal(this.peer, this.isAwaitingAcceptance
          ? { type: 'reject', call_id: this.callId, reason: 'declined' }
          : { type: 'hangup', call_id: this.callId });
      }
    } finally {
      this.cleanup();
      this.cb.onState('ended');
    }
  }

  async handleSignal(from: string, signal: WireCallSignal) {
    switch (signal.type) {
      case 'invite':
        if (!from || !signal.call_id || !signal.sdp || this.seenCallIds.has(signal.call_id)) return;
        if (this.callId) {
          this.cb.sendSignal(from, { type: 'reject', call_id: signal.call_id, reason: 'busy' });
          return;
        }
        this.rememberCallId(signal.call_id);
        this.callId = signal.call_id;
        this.peer = from;
        this.isCaller = false;
        if (!await this.loadPeerSigningKey(from, signal.call_id)
          || this.callId !== signal.call_id
          || this.peer !== from) {
          if (this.callId === signal.call_id && this.peer === from) this.failSecurity('reject');
          return;
        }
        if (!this.verifySdp(signal.sdp, signal.sig)) {
          this.failSecurity('reject');
          return;
        }
        this.pendingOffer = signal.sdp;
        this.incomingFrom = from;
        this.incomingCallId = signal.call_id;
        this.incomingMedia = signal.media;
        this.isAwaitingAcceptance = true;
        this.cb.onIncoming(from, signal.call_id, signal.media);
        break;
      case 'answer':
        if (!this.pc || !this.isCaller || this.remoteReady
          || signal.call_id !== this.callId || from !== this.peer) return;
        if (!this.verifySdp(signal.sdp, signal.sig)) {
          this.failSecurity('hangup');
          return;
        }
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        this.remoteReady = true;
        this.flushCandidates();
        this.cb.onState('connecting');
        await this.emitSas(signal.call_id);
        break;
      case 'ice':
        if (signal.call_id !== this.callId || from !== this.peer) return;
        try {
          const candidate = JSON.parse(signal.candidate) as RTCIceCandidateInit;
          if (this.pc && this.remoteReady) await this.pc.addIceCandidate(candidate).catch(() => undefined);
          else this.pendingCandidates.push(candidate);
        } catch {
          // Ignore malformed candidates without disturbing the active call
        }
        break;
      case 'reject':
      case 'hangup':
        if (signal.call_id === this.callId && from === this.peer) {
          this.cleanup();
          this.cb.onState('ended');
        }
        break;
      default:
        break;
    }
  }

  pendingOffer?: string;

  incomingFrom?: string;

  incomingCallId?: string;

  incomingMedia: CallMedia = 'audio';

  takePendingOffer() {
    const offer = this.pendingOffer;
    this.pendingOffer = undefined;
    return offer;
  }

  async acceptIncoming() {
    if (!this.incomingFrom || !this.incomingCallId || !this.pendingOffer) return false;
    const offer = this.pendingOffer;
    this.pendingOffer = undefined;
    await this.acceptCall(this.incomingFrom, this.incomingCallId, this.incomingMedia, offer);
    this.incomingFrom = undefined;
    this.incomingCallId = undefined;
    return true;
  }

  private async setupPeerConnection(media: CallMedia, callId: string) {
    const iceServers = await this.cb.getIceServers();
    if (this.callId !== callId) return false;
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: this.cb.getIceTransportPolicy(),
    });
    this.pc = pc;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: media === 'video',
    });
    if (this.callId !== callId || this.pc !== pc) {
      stream.getTracks().forEach((track) => track.stop());
      pc.close();
      return false;
    }
    this.localStream = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (e) => {
      if (this.pc === pc && e.streams[0]) this.cb.onRemoteStream(e.streams[0]);
    };
    pc.onicecandidate = (e) => {
      if (this.pc === pc && e.candidate && this.peer && this.callId) {
        this.cb.sendSignal(this.peer, {
          type: 'ice', call_id: this.callId, candidate: JSON.stringify(e.candidate.toJSON()),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') this.cb.onState('active');
      else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this.cleanup();
        this.cb.onState('ended');
      }
    };
    return true;
  }

  private flushCandidates() {
    this.pendingCandidates.forEach((c) => this.pc?.addIceCandidate(c).catch(() => undefined));
    this.pendingCandidates = [];
  }

  private cleanup() {
    this.localStream?.getTracks().forEach((t) => t.stop());
    const pc = this.pc;
    this.pc = undefined;
    pc?.close();
    this.localStream = undefined;
    this.callId = undefined;
    this.peer = undefined;
    this.peerSigningKey = undefined;
    this.isCaller = false;
    this.isAwaitingAcceptance = false;
    this.remoteReady = false;
    this.pendingCandidates = [];
    this.pendingOffer = undefined;
    this.incomingFrom = undefined;
    this.incomingCallId = undefined;
    this.cb.onSas(undefined);
  }

  getLocalStream() {
    return this.localStream;
  }

  private async loadPeerSigningKey(peer: string, callId: string) {
    let key: string | undefined;
    try {
      key = await this.cb.getPeerSigningKey(peer);
    } catch {
      key = undefined;
    }
    if (!this.isCurrentCall(peer, callId)) return false;
    this.peerSigningKey = key;
    return Boolean(key);
  }

  private signSdp(sdp: string) {
    try {
      return this.callId ? this.cb.sign(buildSignedData(this.callId, sdp)) : '';
    } catch {
      return '';
    }
  }

  private verifySdp(sdp: string, signature?: string) {
    return Boolean(this.callId && this.peerSigningKey && signature
      && this.cb.verify(this.peerSigningKey, buildSignedData(this.callId, sdp), signature));
  }

  private failSecurity(notifyPeer?: 'reject' | 'hangup') {
    try {
      if (notifyPeer && this.peer && this.callId) {
        this.cb.sendSignal(this.peer, notifyPeer === 'reject'
          ? { type: 'reject', call_id: this.callId, reason: 'auth_failed' }
          : { type: 'hangup', call_id: this.callId });
      }
    } finally {
      this.cleanup();
      this.cb.onState('security_failed');
    }
  }

  private endAfterMediaFailure(notifyPeer?: 'reject') {
    try {
      if (notifyPeer && this.peer && this.callId) {
        this.cb.sendSignal(this.peer, { type: 'reject', call_id: this.callId, reason: 'media_failed' });
      }
    } finally {
      this.cleanup();
      this.cb.onState('ended');
    }
  }

  private isCurrentCall(peer: string, callId: string) {
    return this.peer === peer && this.callId === callId;
  }

  private isCurrentConnection(peer: string, callId: string, pc: RTCPeerConnection) {
    return this.isCurrentCall(peer, callId) && this.pc === pc;
  }

  private rememberCallId(callId: string) {
    this.seenCallIds.add(callId);
    if (this.seenCallIds.size > 128) {
      const oldest = this.seenCallIds.values().next().value;
      if (oldest) this.seenCallIds.delete(oldest);
    }
  }

  private async emitSas(callId: string) {
    const localSdp = this.pc?.localDescription?.sdp;
    const remoteSdp = this.pc?.remoteDescription?.sdp;
    if (!localSdp || !remoteSdp) return;
    const sas = await buildSas(localSdp, remoteSdp);
    if (sas && callId === this.callId) this.cb.onSas(sas);
  }
}

function buildSignedData(callId: string, sdp: string) {
  return `${callId}\n${sdp}`;
}

function parseFingerprint(sdp: string) {
  const match = sdp.match(/^a=fingerprint:[^ ]+ (.+)\r?$/m);
  return match?.[1];
}

async function buildSas(localSdp: string, remoteSdp: string) {
  const localFingerprint = parseFingerprint(localSdp);
  const remoteFingerprint = parseFingerprint(remoteSdp);
  if (!localFingerprint || !remoteFingerprint) return undefined;
  const fingerprints = [localFingerprint, remoteFingerprint].sort();
  const input = new TextEncoder().encode(fingerprints.join('|'));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(hash.slice(0, 4), (byte) => SAS_EMOJI[byte % SAS_EMOJI.length]).join('');
}
