import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { WireCallSignal } from './callengine';
import type { GroupPeerState, WireGroupInvite } from './groupcall';
import type { ParvaneStore } from './store';

import { createCallController } from './calls';
import { GroupCallEngine } from './groupcall';

// Отказ от приглашения в групповой звонок — сигнал уровня звонка (`reject` с
// call_id = id группового звонка) каждому участнику. Раньше отказ шёл только
// попарно, на полученный invite, и приглашённый с адресом МЕНЬШЕ инициатора
// (оффер в паре шлёт он сам, invite ему не приходит) отказать не мог: строка
// у инициатора закрывалась таймаутом соединения (45 с). Адреса выдуманные.
const AMY = 'amy@example.test';
const BEN = 'ben@example.test';
const CLEO = 'cleo@example.test';
const GROUP_CALL = '0f3c1a52-7d1e-4b8a-9c2f-5e6d7a8b9c0d';
const OTHER_CALL = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';

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

  setLocalDescription() {
    return Promise.resolve();
  }

  setRemoteDescription() {
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

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => Promise.resolve(fakeStream)) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

function createEngine(self: string) {
  const signals: Array<{ peer: string; signal: WireCallSignal | WireGroupInvite; groupCallId?: string }> = [];
  const states: Array<{ peer: string; state: GroupPeerState }> = [];
  let endedCount = 0;
  const engine = new GroupCallEngine(self, {
    sendSignal: (peer, signal, groupCallId) => {
      signals.push({ peer, signal, groupCallId });
    },
    getPeerSigningKeys: () => Promise.resolve([]),
    isSealedPeer: () => Promise.resolve(true),
    getIceServers: () => Promise.resolve([]),
    getIceTransportPolicy: () => undefined,
    onPeerState: (peer, state) => {
      states.push({ peer, state });
    },
    onPeerStream: () => undefined,
    onEnded: () => {
      endedCount += 1;
    },
  });
  return {
    engine, signals, states, ended: () => endedCount,
  };
}

describe('Групповой звонок: отказ уровня звонка (движок)', () => {
  it('инициатор с бóльшим адресом закрывает строку отказавшего сразу — «отклонил»', async () => {
    // Клео звонит; Эми сортируется раньше, оффер в паре за Эми — invite от Клео ей не уходит
    const ctx = createEngine(CLEO);
    ctx.engine.joinMesh(GROUP_CALL, [AMY, BEN, CLEO], 'audio');

    await ctx.engine.handleSignal(AMY, { type: 'reject', call_id: GROUP_CALL, reason: 'declined' }, true);

    expect(ctx.states).toContainEqual({ peer: AMY, state: 'declined' });
    // Звонок с остальными продолжается
    expect(ctx.ended()).toBe(0);
    expect(ctx.engine.currentGroupCallId).toBe(GROUP_CALL);
  });

  it('«занят» уровня звонка — строка «занят»', async () => {
    const ctx = createEngine(CLEO);
    ctx.engine.joinMesh(GROUP_CALL, [AMY, BEN, CLEO], 'audio');

    await ctx.engine.handleSignal(AMY, { type: 'reject', call_id: GROUP_CALL, reason: 'busy' }, true);

    expect(ctx.states).toContainEqual({ peer: AMY, state: 'busy' });
    expect(ctx.engine.currentGroupCallId).toBe(GROUP_CALL);
  });

  it('отказ для другого группового звонка и попарный отказ без своего оффера игнорируются', async () => {
    const ctx = createEngine(CLEO);
    ctx.engine.joinMesh(GROUP_CALL, [AMY, BEN, CLEO], 'audio');

    await ctx.engine.handleSignal(AMY, { type: 'reject', call_id: OTHER_CALL, reason: 'declined' }, true);
    await ctx.engine.handleSignal(BEN, { type: 'reject', call_id: OTHER_CALL, reason: 'declined' }, true);

    expect(ctx.states.some(({ state }) => state === 'declined' || state === 'ended')).toBe(false);
  });

  it('отказ уровня звонка после применённого answer (другое устройство участника) не роняет сессию', async () => {
    // Эми звонит и шлёт оффер Бену; Бен ответил с одного устройства, другое прислало отказ
    const ctx = createEngine(AMY);
    ctx.engine.joinMesh(GROUP_CALL, [AMY, BEN], 'audio');
    await vi.waitFor(() => {
      expect(ctx.signals.some(({ signal }) => signal.type === 'invite')).toBe(true);
    });
    const invite = ctx.signals.find(({ signal }) => signal.type === 'invite')!.signal as { call_id: string };
    await ctx.engine.handleSignal(BEN, { type: 'answer', call_id: invite.call_id, sdp: 'v=0 answer' }, true);

    await ctx.engine.handleSignal(BEN, { type: 'reject', call_id: GROUP_CALL, reason: 'declined' }, true);

    expect(ctx.states.some(({ state }) => state === 'declined')).toBe(false);
    expect(ctx.ended()).toBe(0);
  });

  it('declineCall шлёт отказ каждому участнику, кроме себя, с id группового звонка', () => {
    const ctx = createEngine(AMY);
    ctx.engine.declineCall(GROUP_CALL, [AMY, BEN, CLEO], 'declined');

    expect(ctx.signals).toEqual([
      { peer: BEN, signal: { type: 'reject', call_id: GROUP_CALL, reason: 'declined' }, groupCallId: GROUP_CALL },
      { peer: CLEO, signal: { type: 'reject', call_id: GROUP_CALL, reason: 'declined' }, groupCallId: GROUP_CALL },
    ]);
  });
});

type CallWindow = {
  parvaneCall?: {
    state: string;
    group?: { peerStates: Record<string, GroupPeerState> };
  };
};

function createController(self: string) {
  const sent: Array<{ to: string; signal: WireCallSignal | WireGroupInvite; groupCallId?: string }> = [];
  const own: WireCallSignal[] = [];
  const store = {
    self,
    getDisplayName: (address: string) => address.split('@')[0],
    getGroupAddresses: () => [],
    getGroupInfo: () => undefined,
    isGroupAddress: () => false,
    getAddressForId: () => undefined,
  } as unknown as ParvaneStore;
  const controller = createCallController({
    getConnection: () => undefined,
    getStore: () => store,
    getToken: () => '',
    isIdentityReady: () => true,
    isBlocked: () => false,
    sendUpdate: () => undefined,
    pushReadState: () => undefined,
    sendV2Signal: (to, signal, groupCallId) => {
      sent.push({ to, signal, groupCallId });
      return Promise.resolve(true);
    },
    sendV2OwnSignal: (signal) => {
      own.push(signal);
      return Promise.resolve(true);
    },
    isV2Peer: () => Promise.resolve(true),
    log: () => undefined,
  });
  controller.setup();
  return { controller, sent, own };
}

const ring = (participants: string[], groupCallId = GROUP_CALL): WireGroupInvite => ({
  type: 'group_invite', group_call_id: groupCallId, participants, media: 'audio',
});

describe('Групповой звонок: отказ уровня звонка (контроллер)', () => {
  afterEach(() => {
    delete (window as CallWindow).parvaneCall;
  });

  it('приглашённый с меньшим адресом отклоняет — отказ всем участникам, свои устройства замолкают', async () => {
    const { controller, sent, own } = createController(AMY);
    controller.handleV2Signal(CLEO, ring([AMY, BEN, CLEO]));
    expect((window as CallWindow).parvaneCall?.state).toBe('incoming');

    controller.hangUp();

    await vi.waitFor(() => {
      expect(sent.filter(({ signal }) => signal.type === 'reject')).toHaveLength(2);
    });
    const rejects = sent.filter(({ signal }) => signal.type === 'reject');
    expect(rejects.map(({ to }) => to).sort()).toEqual([BEN, CLEO]);
    rejects.forEach(({ signal, groupCallId }) => {
      expect(signal).toEqual({ type: 'reject', call_id: GROUP_CALL, reason: 'declined' });
      expect(groupCallId).toBe(GROUP_CALL);
    });
    expect(own).toEqual([{ type: 'reject', call_id: GROUP_CALL, reason: 'declined' }]);
    // Микрофон до согласия не запрашивался
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('занятый групповым приглашением отвечает «занят» всем участникам второго звонка, один раз', async () => {
    const { controller, sent } = createController(AMY);
    controller.handleV2Signal(CLEO, ring([AMY, BEN, CLEO]));
    controller.handleV2Signal(BEN, ring([AMY, BEN], OTHER_CALL));
    controller.handleV2Signal(BEN, ring([AMY, BEN], OTHER_CALL));

    await vi.waitFor(() => {
      expect(sent.filter(({ signal }) => signal.type === 'reject')).toHaveLength(1);
    });
    expect(sent.find(({ signal }) => signal.type === 'reject')).toEqual({
      to: BEN, signal: { type: 'reject', call_id: OTHER_CALL, reason: 'busy' }, groupCallId: OTHER_CALL,
    });
  });

  it('отказ, пришедший до согласия, закрывает строку отказавшего после входа в звонок', async () => {
    // Бен ждёт решения; Эми (адрес меньше Клео) отклонила — её отказ копится и применяется при входе
    const { controller } = createController(BEN);
    controller.handleV2Signal(CLEO, ring([AMY, BEN, CLEO]));
    controller.handleV2Signal(AMY, { type: 'reject', call_id: GROUP_CALL, reason: 'declined' }, GROUP_CALL);

    await controller.acceptIncoming();

    await vi.waitFor(() => {
      expect((window as CallWindow).parvaneCall?.group?.peerStates[AMY]).toBe('declined');
    });
  });

  it('инициатор видит «отклонил» у приглашённого с меньшим адресом сразу', async () => {
    const { controller } = createController(CLEO);
    // Инициатор входит в звонок своим путём; здесь — как участник, уже вошедший в mesh
    controller.handleV2Signal(BEN, ring([AMY, BEN, CLEO]));
    await controller.acceptIncoming();

    controller.handleV2Signal(AMY, { type: 'reject', call_id: GROUP_CALL, reason: 'declined' }, GROUP_CALL);

    await vi.waitFor(() => {
      expect((window as CallWindow).parvaneCall?.group?.peerStates[AMY]).toBe('declined');
    });
  });
});
