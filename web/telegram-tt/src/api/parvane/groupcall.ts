// Групповые звонки: mesh из pairwise WebRTC-сессий (протокол desktop).
// Каждая пара — обычные invite/answer/ice в отдельный инбокс
// call.user.gcall:<peer>; оффер инициирует лексикографически меньший адрес
// (детерминированное разрешение glare), входящие в mesh принимаются
// автоматически. Локальный поток один на звонок, треки шарятся между pc.

import type { CallMedia, WireCallSignal } from './callengine';

export type WireGroupInvite = {
  type: 'group_invite';
  group_call_id: string;
  participants: string[];
  media: CallMedia;
};

export type GroupPeerState = 'connecting' | 'active' | 'ended' | 'security_failed';

type GroupCallCallbacks = {
  // Контроллер сам добавляет gcall:-префикс к адресу получателя
  sendSignal: (peer: string, signal: WireCallSignal | WireGroupInvite) => void;
  getPeerSigningKeys: (peer: string) => Promise<string[]>;
  getIceServers: () => Promise<RTCIceServer[]>;
  getIceTransportPolicy: () => RTCIceTransportPolicy | undefined;
  sign: (data: string) => string;
  verify: (publicKey: string, data: string, signature: string) => boolean;
  onPeerState: (peer: string, state: GroupPeerState) => void;
  onPeerStream: (peer: string, stream: MediaStream) => void;
  onEnded: () => void;
};

// Явный клиентский лимит mesh: N-1 исходящих потоков на участника; сервер
// допускает до 32, но аудио-mesh больше восьми деградирует
export const GROUP_CALL_MAX_PARTICIPANTS = 8;

function buildSignedData(callId: string, sdp: string) {
  return `${callId}\n${sdp}`;
}

class MeshPeerSession {
  pc?: RTCPeerConnection;

  callId?: string;

  private remoteReady = false;

  private pendingCandidates: RTCIceCandidateInit[] = [];

  private peerSigningKeys: string[] = [];

  private isEnded = false;

  constructor(
    private peer: string,
    private engine: GroupCallEngine,
    private cb: GroupCallCallbacks,
  ) {}

  async startOffer(media: CallMedia) {
    this.callId = crypto.randomUUID();
    try {
      if (!await this.loadKey()) return this.fail();
      const pc = await this.createPc(media);
      if (!pc) return undefined;
      const offer = await pc.createOffer();
      if (this.pc !== pc) return undefined;
      await pc.setLocalDescription(offer);
      if (this.pc !== pc) return undefined;
      const sdp = offer.sdp || '';
      const sig = this.sign(sdp);
      if (!sig) return this.fail();
      this.cb.sendSignal(this.peer, {
        type: 'invite', call_id: this.callId, media, sdp, sig,
      });
      this.cb.onPeerState(this.peer, 'connecting');
    } catch {
      this.end(false);
    }
    return undefined;
  }

  async acceptOffer(callId: string, media: CallMedia, offerSdp: string, sig?: string) {
    this.callId = callId;
    try {
      if (!await this.loadKey()) return this.fail();
      if (!this.verify(offerSdp, sig)) return this.fail();
      const pc = await this.createPc(media);
      if (!pc) return undefined;
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      if (this.pc !== pc) return undefined;
      this.remoteReady = true;
      this.flushCandidates();
      const answer = await pc.createAnswer();
      if (this.pc !== pc) return undefined;
      await pc.setLocalDescription(answer);
      if (this.pc !== pc) return undefined;
      const sdp = answer.sdp || '';
      const answerSig = this.sign(sdp);
      if (!answerSig) return this.fail();
      this.cb.sendSignal(this.peer, {
        type: 'answer', call_id: callId, sdp, sig: answerSig,
      });
      this.cb.onPeerState(this.peer, 'connecting');
    } catch {
      this.end(false);
    }
    return undefined;
  }

  async handleSignal(signal: WireCallSignal) {
    switch (signal.type) {
      case 'answer':
        if (!this.pc || this.remoteReady || signal.call_id !== this.callId) return;
        if (!this.verify(signal.sdp, signal.sig)) {
          this.fail();
          return;
        }
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        this.remoteReady = true;
        this.flushCandidates();
        break;
      case 'ice':
        if (signal.call_id !== this.callId) return;
        try {
          const candidate = JSON.parse(signal.candidate) as RTCIceCandidateInit;
          if (this.pc && this.remoteReady) await this.pc.addIceCandidate(candidate).catch(() => undefined);
          else this.pendingCandidates.push(candidate);
        } catch {
          // Битые кандидаты не должны валить сессию
        }
        break;
      case 'reject':
      case 'hangup':
        if (signal.call_id === this.callId) this.end(false);
        break;
      default:
        break;
    }
  }

  hangup() {
    if (this.callId && !this.isEnded) {
      this.cb.sendSignal(this.peer, { type: 'hangup', call_id: this.callId });
    }
    this.end(true);
  }

  private async createPc(media: CallMedia) {
    const iceServers = await this.cb.getIceServers();
    if (this.isEnded) return undefined;
    const stream = await this.engine.ensureLocalStream(media);
    if (this.isEnded || !stream) return undefined;
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: this.cb.getIceTransportPolicy(),
    });
    this.pc = pc;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.ontrack = (e) => {
      if (this.pc === pc && e.streams[0]) this.cb.onPeerStream(this.peer, e.streams[0]);
    };
    pc.onicecandidate = (e) => {
      if (this.pc === pc && e.candidate && this.callId) {
        this.cb.sendSignal(this.peer, {
          type: 'ice', call_id: this.callId, candidate: JSON.stringify(e.candidate.toJSON()),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') this.cb.onPeerState(this.peer, 'active');
      else if (s === 'failed' || s === 'disconnected' || s === 'closed') this.end(false);
    };
    return pc;
  }

  private flushCandidates() {
    this.pendingCandidates.forEach((c) => this.pc?.addIceCandidate(c).catch(() => undefined));
    this.pendingCandidates = [];
  }

  private loadKey = async () => {
    try {
      this.peerSigningKeys = await this.cb.getPeerSigningKeys(this.peer);
    } catch {
      this.peerSigningKeys = [];
    }
    return this.peerSigningKeys.length > 0;
  };

  private sign(sdp: string) {
    try {
      return this.callId ? this.cb.sign(buildSignedData(this.callId, sdp)) : '';
    } catch {
      return '';
    }
  }

  private verify(sdp: string, signature?: string) {
    if (!this.callId || !signature) return false;
    const data = buildSignedData(this.callId, sdp);
    return this.peerSigningKeys.some((key) => this.cb.verify(key, data, signature));
  }

  private fail() {
    this.close();
    this.cb.onPeerState(this.peer, 'security_failed');
    this.engine.onSessionClosed(this.peer);
    return undefined;
  }

  private end(isLocal: boolean) {
    if (this.isEnded) return;
    this.close();
    this.cb.onPeerState(this.peer, 'ended');
    if (!isLocal) this.engine.onSessionClosed(this.peer);
  }

  private close() {
    this.isEnded = true;
    const pc = this.pc;
    this.pc = undefined;
    pc?.close();
  }
}

export class GroupCallEngine {
  private sessions = new Map<string, MeshPeerSession>();

  private groupCallId?: string;

  private media: CallMedia = 'audio';

  private localStream?: MediaStream;

  private localStreamPromise?: Promise<MediaStream | undefined>;

  constructor(private self: string, private cb: GroupCallCallbacks) {}

  get currentGroupCallId() {
    return this.groupCallId;
  }

  getLocalStream() {
    return this.localStream;
  }

  startCall(groupCallId: string, participants: string[], media: CallMedia) {
    participants.forEach((peer) => {
      if (peer !== this.self) {
        this.cb.sendSignal(peer, {
          type: 'group_invite', group_call_id: groupCallId, participants, media,
        });
      }
    });
    this.joinMesh(groupCallId, participants, media);
  }

  joinMesh(groupCallId: string, participants: string[], media: CallMedia) {
    this.groupCallId = groupCallId;
    this.media = media || 'audio';
    for (const peer of participants) {
      if (peer === this.self || this.sessions.has(peer)) continue;
      const session = new MeshPeerSession(peer, this, this.cb);
      this.sessions.set(peer, session);
      // Оффер шлёт лексикографически меньший адрес; иначе ждём invite
      if (this.self < peer) void session.startOffer(this.media);
    }
  }

  async handleSignal(from: string, signal: WireCallSignal | WireGroupInvite) {
    if (signal.type === 'group_invite') {
      // Уже в другом групповом звонке — игнорируем приглашение
      if (this.groupCallId && this.groupCallId !== signal.group_call_id) return;
      this.joinMesh(signal.group_call_id, signal.participants, signal.media);
      return;
    }
    let session = this.sessions.get(from);
    if (!session && signal.type === 'invite' && this.groupCallId) {
      session = new MeshPeerSession(from, this, this.cb);
      this.sessions.set(from, session);
    }
    if (!session) return;
    if (signal.type === 'invite') {
      // Mesh-инвайт принимается автоматически, без отдельного «принять»
      await session.acceptOffer(signal.call_id, signal.media, signal.sdp, signal.sig);
      return;
    }
    await session.handleSignal(signal);
  }

  leave() {
    this.sessions.forEach((session) => session.hangup());
    this.sessions.clear();
    this.stopLocalStream();
    this.groupCallId = undefined;
    this.cb.onEnded();
  }

  onSessionClosed(peer: string) {
    this.sessions.delete(peer);
    if (this.groupCallId && !this.sessions.size) {
      this.stopLocalStream();
      this.groupCallId = undefined;
      this.cb.onEnded();
    }
  }

  async ensureLocalStream(media: CallMedia) {
    if (this.localStream) return this.localStream;
    if (!this.localStreamPromise) {
      this.localStreamPromise = navigator.mediaDevices
        .getUserMedia({ audio: true, video: media === 'video' })
        .then((stream) => {
          this.localStream = stream;
          return stream;
        })
        .catch(() => undefined);
    }
    return this.localStreamPromise;
  }

  private stopLocalStream() {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = undefined;
    this.localStreamPromise = undefined;
  }
}
