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

export type CallState = 'requesting' | 'ringing' | 'connecting' | 'active' | 'ended';

type CallCallbacks = {
  sendSignal: (to: string, signal: WireCallSignal) => void;
  onState: (state: CallState) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onIncoming: (from: string, callId: string, media: CallMedia) => void;
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export class CallEngine {
  private pc?: RTCPeerConnection;

  private localStream?: MediaStream;

  private callId?: string;

  private peer?: string;

  private isCaller = false;

  private pendingCandidates: RTCIceCandidateInit[] = [];

  private remoteReady = false;

  constructor(private cb: CallCallbacks) {}

  get currentCallId() {
    return this.callId;
  }

  get currentPeer() {
    return this.peer;
  }

  // Инициировать звонок к peer
  async placeCall(peer: string, media: CallMedia) {
    this.callId = crypto.randomUUID();
    this.peer = peer;
    this.isCaller = true;
    this.cb.onState('requesting');

    await this.setupPeerConnection(media);
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.cb.sendSignal(peer, {
      type: 'invite', call_id: this.callId, media, sdp: offer.sdp || '',
    });
    this.cb.onState('ringing');
  }

  // Принять входящий звонок (после onIncoming)
  async acceptCall(from: string, callId: string, media: CallMedia, offerSdp: string) {
    this.callId = callId;
    this.peer = from;
    this.isCaller = false;
    this.cb.onState('connecting');

    await this.setupPeerConnection(media);
    await this.pc!.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    this.remoteReady = true;
    this.flushCandidates();

    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.cb.sendSignal(from, { type: 'answer', call_id: callId, sdp: answer.sdp || '' });
  }

  rejectCall(from: string, callId: string) {
    this.cb.sendSignal(from, { type: 'reject', call_id: callId });
  }

  hangUp() {
    if (this.peer && this.callId) {
      this.cb.sendSignal(this.peer, { type: 'hangup', call_id: this.callId });
    }
    this.cleanup();
    this.cb.onState('ended');
  }

  // Обработка входящего сигнала
  async handleSignal(from: string, signal: WireCallSignal) {
    switch (signal.type) {
      case 'invite':
        // Уже в звонке — отклоняем (busy)
        if (this.callId && this.callId !== signal.call_id) {
          this.cb.sendSignal(from, { type: 'reject', call_id: signal.call_id, reason: 'busy' });
          return;
        }
        this.pendingOffer = signal.sdp;
        this.incomingFrom = from;
        this.incomingCallId = signal.call_id;
        this.incomingMedia = signal.media;
        this.cb.onIncoming(from, signal.call_id, signal.media);
        break;
      case 'answer':
        if (this.pc && signal.call_id === this.callId) {
          await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          this.remoteReady = true;
          this.flushCandidates();
          this.cb.onState('connecting');
        }
        break;
      case 'ice':
        if (signal.call_id === this.callId) {
          const candidate = JSON.parse(signal.candidate) as RTCIceCandidateInit;
          if (this.pc && this.remoteReady) {
            await this.pc.addIceCandidate(candidate).catch(() => undefined);
          } else {
            this.pendingCandidates.push(candidate);
          }
        }
        break;
      case 'reject':
      case 'hangup':
        if (signal.call_id === this.callId) {
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

  // Забрать сохранённый offer для acceptCall
  takePendingOffer() {
    const offer = this.pendingOffer;
    this.pendingOffer = undefined;
    return offer;
  }

  // Принять текущий входящий (данные сохранены при invite)
  async acceptIncoming() {
    if (!this.incomingFrom || !this.incomingCallId || !this.pendingOffer) return false;
    const offer = this.pendingOffer;
    this.pendingOffer = undefined;
    await this.acceptCall(this.incomingFrom, this.incomingCallId, this.incomingMedia, offer);
    this.incomingFrom = undefined;
    this.incomingCallId = undefined;
    return true;
  }

  private async setupPeerConnection(media: CallMedia) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: media === 'video',
    });
    this.localStream.getTracks().forEach((track) => this.pc!.addTrack(track, this.localStream!));

    this.pc.ontrack = (e) => {
      if (e.streams[0]) this.cb.onRemoteStream(e.streams[0]);
    };
    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.peer && this.callId) {
        this.cb.sendSignal(this.peer, {
          type: 'ice', call_id: this.callId, candidate: JSON.stringify(e.candidate.toJSON()),
        });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'connected') this.cb.onState('active');
      else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this.cleanup();
        this.cb.onState('ended');
      }
    };
  }

  private flushCandidates() {
    this.pendingCandidates.forEach((c) => this.pc?.addIceCandidate(c).catch(() => undefined));
    this.pendingCandidates = [];
  }

  private cleanup() {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.pc = undefined;
    this.localStream = undefined;
    this.callId = undefined;
    this.peer = undefined;
    this.remoteReady = false;
    this.pendingCandidates = [];
  }

  getLocalStream() {
    return this.localStream;
  }
}
