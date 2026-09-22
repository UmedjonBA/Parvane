import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireCallSignal } from './callengine';
import type { GroupPeerState, WireGroupInvite } from './groupcall';

import { GroupCallEngine } from './groupcall';

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

class FakePeerConnection {
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

async function startCallAndReadInvite(ctx: ReturnType<typeof createEngine>) {
  ctx.engine.joinMesh('gc-1', [SELF, PEER], 'audio');
  await vi.waitFor(() => {
    expect(ctx.signals.some(({ signal }) => signal.type === 'invite')).toBe(true);
  });
  const { signal } = ctx.signals.find((entry) => entry.signal.type === 'invite')!;
  return (signal as Extract<WireCallSignal, { type: 'invite' }>).call_id;
}

describe('Групповой звонок: отказ с другого устройства принявшего участника', () => {
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

  it('reject{declined} после применённого answer не роняет сессию и не заканчивает звонок', async () => {
    const ctx = createEngine();
    const callId = await startCallAndReadInvite(ctx);

    // Первое устройство участника приняло вызов
    await ctx.engine.handleSignal(PEER, {
      type: 'answer', call_id: callId, sdp: 'v=0 answer', sig: 'sig',
    });
    const statesAfterAnswer = ctx.states.length;

    // Второе устройство отклонило то же приглашение по своему таймауту
    await ctx.engine.handleSignal(PEER, { type: 'reject', call_id: callId, reason: 'declined' });

    expect(ctx.states.slice(statesAfterAnswer)).toEqual([]);
    expect(ctx.ended()).toBe(0);
    expect(ctx.engine.currentGroupCallId).toBe('gc-1');
  });

  it('reject{busy} после применённого answer тоже игнорируется', async () => {
    const ctx = createEngine();
    const callId = await startCallAndReadInvite(ctx);
    await ctx.engine.handleSignal(PEER, {
      type: 'answer', call_id: callId, sdp: 'v=0 answer', sig: 'sig',
    });

    await ctx.engine.handleSignal(PEER, { type: 'reject', call_id: callId, reason: 'busy' });

    expect(ctx.states.some(({ state }) => state === 'busy' || state === 'ended')).toBe(false);
    expect(ctx.ended()).toBe(0);
  });

  it('reject до answer по-прежнему закрывает сессию (обычный отказ участника)', async () => {
    const ctx = createEngine();
    const callId = await startCallAndReadInvite(ctx);

    await ctx.engine.handleSignal(PEER, { type: 'reject', call_id: callId, reason: 'declined' });

    expect(ctx.states.at(-1)).toEqual({ peer: PEER, state: 'ended' });
    // Единственная сессия закрыта — звонок на двоих окончен
    expect(ctx.ended()).toBe(1);
    expect(ctx.engine.currentGroupCallId).toBeUndefined();
  });

  it('hangup принявшего устройства после answer завершает сессию как раньше', async () => {
    const ctx = createEngine();
    const callId = await startCallAndReadInvite(ctx);
    await ctx.engine.handleSignal(PEER, {
      type: 'answer', call_id: callId, sdp: 'v=0 answer', sig: 'sig',
    });

    await ctx.engine.handleSignal(PEER, { type: 'hangup', call_id: callId });

    expect(ctx.states.at(-1)).toEqual({ peer: PEER, state: 'ended' });
    expect(ctx.ended()).toBe(1);
  });
});
