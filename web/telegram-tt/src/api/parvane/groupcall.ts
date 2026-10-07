// Групповые звонки: mesh из pairwise WebRTC-сессий (протокол desktop).
// Каждая пара — обычные invite/answer/ice в отдельный инбокс
// call.user.gcall:<peer>; оффер инициирует лексикографически меньший адрес
// (детерминированное разрешение glare). В звонок входят только после
// согласия пользователя (calls.ts), дальше парные invite внутри mesh
// принимаются сами. Локальный поток один на звонок, треки шарятся между pc.

import type { CallMedia, WireCallSignal } from './callengine';

import { decodeIceCandidate, encodeIceCandidate } from './iceCandidate';

export type WireGroupInvite = {
  type: 'group_invite';
  group_call_id: string;
  participants: string[];
  media: CallMedia;
};

export type GroupPeerState = 'connecting' | 'active' | 'ended' | 'security_failed' | 'busy';

type GroupCallCallbacks = {
  // Контроллер сам добавляет gcall:-префикс к адресу получателя
  sendSignal: (peer: string, signal: WireCallSignal | WireGroupInvite) => void;
  getPeerSigningKeys: (peer: string) => Promise<string[]>;
  // Участник на протоколе v2: попарные сигналы идут запечатанными конвертами,
  // подпись SDP не нужна — оффер допустим и без v1-ключей подписи (сервер без v1)
  isSealedPeer?: (peer: string) => Promise<boolean>;
  getIceServers: () => Promise<RTCIceServer[]>;
  getIceTransportPolicy: () => RTCIceTransportPolicy | undefined;
  // Сколько ждать соединения с участником, прежде чем закрыть его строку
  getRingTimeoutMs?: () => number;
  // Подпись SDP (прежний v1-путь); без неё сигнал идёт без `sig` — отправителя
  // аутентифицирует конверт v2 (`isAuthenticated`)
  sign?: (data: string) => string;
  verify?: (publicKey: string, data: string, signature: string) => boolean;
  onPeerState: (peer: string, state: GroupPeerState) => void;
  onPeerStream: (peer: string, stream: MediaStream) => void;
  onEnded: () => void;
};

// Явный клиентский лимит mesh: N-1 исходящих потоков на участника; сервер
// допускает до 32, но аудио-mesh больше восьми деградирует
export const GROUP_CALL_MAX_PARTICIPANTS = 8;
const PEER_CONNECT_TIMEOUT_MS = 45000;

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

  private connectTimer?: number;

  constructor(
    private peer: string,
    private engine: GroupCallEngine,
    private cb: GroupCallCallbacks,
  ) {
    // Участник не принял приглашение / не ответил: строка не должна висеть
    // «connecting» — закрываем сессию по таймауту вызова
    this.connectTimer = window.setTimeout(() => {
      if (this.isEnded || this.pc?.connectionState === 'connected') return;
      this.hangup();
      this.engine.onSessionClosed(this.peer);
    }, this.cb.getRingTimeoutMs?.() ?? PEER_CONNECT_TIMEOUT_MS);
  }

  async startOffer(media: CallMedia) {
    this.callId = crypto.randomUUID();
    try {
      if (!await this.loadKey() && !await this.cb.isSealedPeer?.(this.peer).catch(() => false)) {
        return this.fail();
      }
      const pc = await this.createPc(media);
      if (!pc) return undefined;
      const offer = await pc.createOffer();
      if (this.pc !== pc) return undefined;
      await pc.setLocalDescription(offer);
      if (this.pc !== pc) return undefined;
      const sdp = offer.sdp || '';
      const sig = this.sign(sdp);
      if (this.cb.sign && !sig) return this.fail();
      this.cb.sendSignal(this.peer, {
        type: 'invite', call_id: this.callId, media, sdp, sig,
      });
      this.cb.onPeerState(this.peer, 'connecting');
    } catch {
      this.end(false);
    }
    return undefined;
  }

  // `isAuthenticated` — сигнал пришёл по v2: отправителя проверил движок
  // (сертификат устройства, аудитория, привязка к звонку), подписи SDP в нём нет
  async acceptOffer(callId: string, media: CallMedia, offerSdp: string, sig?: string, isAuthenticated = false) {
    this.callId = callId;
    try {
      if (!isAuthenticated && !await this.loadKey()) return this.fail();
      if (!isAuthenticated && !this.verify(offerSdp, sig)) return this.fail();
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
      if (this.cb.sign && !answerSig) return this.fail();
      this.cb.sendSignal(this.peer, {
        type: 'answer', call_id: callId, sdp, sig: answerSig,
      });
      this.cb.onPeerState(this.peer, 'connecting');
    } catch {
      this.end(false);
    }
    return undefined;
  }

  async handleSignal(signal: WireCallSignal, isAuthenticated = false) {
    switch (signal.type) {
      case 'answer':
        if (!this.pc || this.remoteReady || signal.call_id !== this.callId) return;
        if (!isAuthenticated && !this.verify(signal.sdp, signal.sig)) {
          this.fail();
          return;
        }
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        this.remoteReady = true;
        this.flushCandidates();
        break;
      case 'ice':
        if (signal.call_id !== this.callId) return;
        {
          // CALL-1: понимаем канонический вид и прежние виды web и desktop;
          // битый кандидат не должен валить звонок
          const candidate = decodeIceCandidate(signal.candidate);
          if (!candidate) break;
          if (this.pc && this.remoteReady) await this.pc.addIceCandidate(candidate).catch(() => undefined);
          else this.pendingCandidates.push(candidate);
        }
        break;
      case 'reject':
        // Своего call_id у сессии нет, пока оффер за участником (правило glare:
        // шлёт лексикографически меньший адрес); до его invite reject от него
        // прийти не может (шард форвардит reject только по записи invite), и
        // строка закрывается таймаутом соединения
        if (this.callId && signal.call_id !== this.callId) return;
        // Ответ уже применён — сессия ведёт разговор с тем устройством
        // участника, которое приняло вызов. Отказ с тем же call_id может
        // прислать только ДРУГОЕ его устройство (приглашение звонит на всех,
        // и остальные отклоняют его по своему таймауту): ронять по нему живую
        // сессию нельзя. Уход принявшего устройства приходит сигналом hangup
        if (this.remoteReady) return;
        if (signal.reason === 'busy') {
          // Участник занят другим звонком: строка остаётся с пометкой «занят»
          this.close();
          this.cb.onPeerState(this.peer, 'busy');
          this.engine.onSessionClosed(this.peer);
          return;
        }
        this.end(false);
        break;
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
    if (this.isEnded) return undefined;
    if (!stream) {
      // Нет доступа к микрофону/камере: сессия не должна висеть «connecting»
      // бесконечно — закрываем и сообщаем пользователю
      if (this.callId) this.cb.sendSignal(this.peer, { type: 'hangup', call_id: this.callId });
      this.end(false);
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('parvane-call-media-error'));
      return undefined;
    }
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
          type: 'ice', call_id: this.callId, candidate: encodeIceCandidate(e.candidate.toJSON()),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        window.clearTimeout(this.connectTimer);
        this.cb.onPeerState(this.peer, 'active');
      } else if (s === 'failed' || s === 'disconnected' || s === 'closed') this.end(false);
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
      return this.callId && this.cb.sign ? this.cb.sign(buildSignedData(this.callId, sdp)) : '';
    } catch {
      return '';
    }
  }

  private verify(sdp: string, signature?: string) {
    if (!this.callId || !signature) return false;
    const data = buildSignedData(this.callId, sdp);
    return this.peerSigningKeys.some((key) => this.cb.verify?.(key, data, signature));
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
    window.clearTimeout(this.connectTimer);
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

  private localStreamGeneration = 0;

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
      // Лимит mesh держим и при ДОБОРЕ участников в идущий звонок, а не только
      // при его создании: иначе девятый и следующие достраивали бы сетку без
      // предела (N-1 исходящих потоков на каждого)
      if (this.sessions.size + 1 >= GROUP_CALL_MAX_PARTICIPANTS) {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('parvane-call-too-many', {
            detail: { limit: GROUP_CALL_MAX_PARTICIPANTS },
          }));
        }
        break;
      }
      const session = new MeshPeerSession(peer, this, this.cb);
      this.sessions.set(peer, session);
      // Оффер шлёт лексикографически меньший адрес; иначе ждём invite
      if (this.self < peer) void session.startOffer(this.media);
    }
  }

  async handleSignal(from: string, signal: WireCallSignal | WireGroupInvite, isAuthenticated = false) {
    if (signal.type === 'group_invite') {
      // Приглашение в идущий звонок (новые участники) — достраиваем mesh;
      // новое приглашение решает контроллер (согласие пользователя)
      if (this.groupCallId === signal.group_call_id) {
        this.joinMesh(signal.group_call_id, signal.participants, signal.media);
      }
      return;
    }
    let session = this.sessions.get(from);
    if (!session && signal.type === 'invite' && this.groupCallId) {
      session = new MeshPeerSession(from, this, this.cb);
      this.sessions.set(from, session);
    }
    if (!session) return;
    if (signal.type === 'invite') {
      // Mesh-инвайт внутри звонка, в который пользователь уже вошёл
      await session.acceptOffer(signal.call_id, signal.media, signal.sdp, signal.sig, isAuthenticated);
      return;
    }
    await session.handleSignal(signal, isAuthenticated);
  }

  // Отказ/занятость на парный invite без входа в mesh (согласие не дано)
  rejectInvite(peer: string, callId: string, reason: string) {
    this.cb.sendSignal(peer, { type: 'reject', call_id: callId, reason });
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
      this.localStreamGeneration += 1;
      this.localStreamPromise = this.requestLocalStream(media, this.localStreamGeneration);
    }
    return this.localStreamPromise;
  }

  // Отказ в доступе к микрофону/камере НЕ кэшируем: запомненный отказ пережил бы
  // и выдачу прав, и все следующие звонки во вкладке — каждый из них мгновенно
  // самоотклонялся бы. Успешный поток кэшируется как раньше (один на звонок).
  // Поколение — чтобы отказ старого запроса (звонок успели закрыть) не сбросил
  // запрос уже следующего звонка
  private async requestLocalStream(media: CallMedia, generation: number) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' });
      this.localStream = stream;
      return stream;
    } catch {
      if (this.localStreamGeneration === generation) {
        this.localStream = undefined;
        this.localStreamPromise = undefined;
      }
      return undefined;
    }
  }

  private stopLocalStream() {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = undefined;
    this.localStreamPromise = undefined;
  }
}
