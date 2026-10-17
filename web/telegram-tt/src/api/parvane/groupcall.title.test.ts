import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireCallSignal } from './callengine';
import type { GroupPeerState, WireGroupInvite } from './groupcall';

import { GroupCallEngine, inviteGroupTitle, PEER_DISCONNECT_GRACE_MS } from './groupcall';

// Название группы во входящем групповом звонке (17 окт 2026): приглашение несёт группу и её
// название; знающий группу берёт своё название, не знающий — из приглашения.
//
// Заглушки WebRTC — как в groupcall.multidevice.test.ts.
// (Ниже — исходный комментарий заглушек.)
// Граничный случай спеки «Второе устройство того же аккаунта»: приглашение в
// групповой звонок звонит на всех устройствах участника, принимает одно, а
// остальные отклоняют его по своему таймауту вызова. Отказ уходит с тем же
// call_id, что и парный invite инициатора, — и до правки ронял у инициатора
// уже установленную сессию с принявшим устройством (в звонке на двоих это
// заканчивало звонок целиком). Здесь: reject после применённого answer
// игнорируется, reject до answer по-прежнему закрывает сессию.
//
// Инициатор — лексикографически меньший адрес, поэтому оффер шлёт он:
// RTCPeerConnection и getUserMedia в jsdom нет — подменяем минимальными
// заглушками.
const SELF = 'alice@bubble';
const PEER = 'bob@bubble';

const createdPcs: FakePeerConnection[] = [];

class FakePeerConnection {
  constructor() {
    createdPcs.push(this);
  }

  connectionState: RTCPeerConnectionState = 'new';

  localDescription?: RTCSessionDescriptionInit;

  remoteDescription?: RTCSessionDescriptionInit;

  ontrack?: unknown;

  onicecandidate?: unknown;

  onconnectionstatechange?: unknown;

  addTrack() {
    return undefined;
  }

  createOffer() {
    return Promise.resolve({ type: 'offer' as const, sdp: 'v=0 offer' });
  }

  createAnswer() {
    return Promise.resolve({ type: 'answer' as const, sdp: 'v=0 answer' });
  }

  setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate() {
    return Promise.resolve();
  }

  close() {
    this.connectionState = 'closed';
  }
}

const fakeStream = {
  getTracks: () => [{ stop: () => undefined }],
  getAudioTracks: () => [],
  getVideoTracks: () => [],
} as unknown as MediaStream;

function createEngine() {
  const signals: Array<{ peer: string; signal: WireCallSignal | WireGroupInvite }> = [];
  const states: Array<{ peer: string; state: GroupPeerState }> = [];
  let endedCount = 0;
  const engine = new GroupCallEngine(SELF, {
    sendSignal: (peer, signal) => {
      signals.push({ peer, signal });
    },
    getPeerSigningKeys: () => Promise.resolve(['peer-key']),
    getIceServers: () => Promise.resolve([]),
    getIceTransportPolicy: () => undefined,
    sign: () => 'sig',
    verify: () => true,
    onPeerState: (peer, state) => {
      states.push({ peer, state });
    },
    onPeerStream: () => undefined,
    onEnded: () => {
      endedCount += 1;
    },
  });
  return {
    engine,
    signals,
    states,
    ended: () => endedCount,
  };
}

describe('Групповой звонок: название группы в приглашении', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(fakeStream) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it('приглашение несёт адрес группы и её название', () => {
    const ctx = createEngine();
    ctx.engine.startCall('gc-1', [SELF, PEER], 'video', { address: 'v2g:ab', title: 'Кружок по средам' });
    const invite = ctx.signals.find(({ signal }) => signal.type === 'group_invite');
    expect(invite).toMatchObject({
      peer: PEER, signal: { group: 'v2g:ab', title: 'Кружок по средам', media: 'video' },
    });
  });

  it('название: своё для известной группы, из приглашения для неизвестной, подбор — для старых клиентов', () => {
    const base: WireGroupInvite = {
      type: 'group_invite', group_call_id: 'gc-1', participants: [SELF, PEER], media: 'audio',
    };
    const known = (group: string) => (group === 'v2g:ab' ? 'Своё название' : undefined);
    const guess = () => 'Подобрано по участникам';
    expect(inviteGroupTitle({ ...base, group: 'v2g:ab', title: 'Подмена' }, known, guess)).toBe('Своё название');
    expect(inviteGroupTitle({ ...base, group: 'v2g:cd', title: 'Из приглашения' }, known, guess))
      .toBe('Из приглашения');
    expect(inviteGroupTitle({ ...base, title: 'Из приглашения' }, known, guess)).toBe('Подобрано по участникам');
    expect(inviteGroupTitle({ ...base, title: 'Из приглашения' }, known, () => undefined)).toBe('Из приглашения');
    expect(inviteGroupTitle(base, known, () => undefined)).toBeUndefined();
  });

  it('кратковременный обрыв (disconnected) не выбрасывает участника, затянувшийся — выбрасывает', async () => {
    createdPcs.length = 0;
    const ctx = createEngine();
    ctx.engine.joinMesh('gc-2', [SELF, PEER], 'audio');
    await vi.waitFor(() => expect(createdPcs.length).toBeGreaterThan(0));
    vi.useFakeTimers();
    try {
      const pc = createdPcs[createdPcs.length - 1];
      const change = (state: RTCPeerConnectionState) => {
        pc.connectionState = state;
        (pc.onconnectionstatechange as () => void)();
      };
      change('connected');
      change('disconnected');
      vi.advanceTimersByTime(PEER_DISCONNECT_GRACE_MS - 1000);
      change('connected');
      vi.advanceTimersByTime(PEER_DISCONNECT_GRACE_MS * 2);
      expect(ctx.states.filter(({ state }) => state === 'ended')).toEqual([]);
      change('disconnected');
      vi.advanceTimersByTime(PEER_DISCONNECT_GRACE_MS + 10);
      expect(ctx.states.some(({ peer, state }) => peer === PEER && state === 'ended')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
