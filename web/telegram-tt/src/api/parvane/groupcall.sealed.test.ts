import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import { GroupCallEngine } from './groupcall';

// Оффер в паре шлёт меньший адрес: SELF < PEER. Журнал устройств PEER (переписки не было) первый раз не прочитался
const SELF = 'amy@bubble';
const PEER = 'zoe@bubble';

describe('Групповой звонок: проверка участника без переписки', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('сбой чтения журнала участника не закрывает пару «проверка не пройдена»', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const isSealedPeer = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(true);
    const engine = new GroupCallEngine(SELF, {
      sendSignal: () => undefined,
      getPeerSigningKeys: () => Promise.resolve([]),
      isSealedPeer,
      // Дальше проверки сессия не идёт: список ICE не отдаётся, RTCPeerConnection не нужен
      getIceServers: () => new Promise(() => undefined),
      getIceTransportPolicy: () => undefined,
      onPeerState: (_peer, state) => states.push(state),
      onPeerStream: () => undefined,
      onEnded: () => undefined,
    });
    engine.joinMesh('call-1', [SELF, PEER], 'audio');
    await vi.advanceTimersByTimeAsync(1500);
    expect(isSealedPeer).toHaveBeenCalledTimes(2);
    expect(states).not.toContain('security_failed');
  });
});
