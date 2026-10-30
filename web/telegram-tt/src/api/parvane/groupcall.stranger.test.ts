import { describe, expect, it } from 'vitest';

import { GroupCallEngine } from './groupcall';

// Во время группового звонка попарный invite и добор по group_invite принимаются только
// от участников этого звонка. Адреса подобраны так, что оффер за `PEER` (self больше),
// RTCPeerConnection в jsdom не нужен.
const SELF = 'zoe@bubble';
const PEER = 'amy@bubble';
const STRANGER = 'eve@bubble';
const NEWBIE = 'ben@bubble';

function createEngine() {
  const states: Array<{ peer: string; state: string }> = [];
  const engine = new GroupCallEngine(SELF, {
    sendSignal: () => undefined,
    getPeerSigningKeys: () => Promise.resolve([]),
    getIceServers: () => Promise.resolve([]),
    getIceTransportPolicy: () => undefined,
    onPeerState: (peer, state) => states.push({ peer, state }),
    onPeerStream: () => undefined,
    onEnded: () => undefined,
  });
  return { engine, states };
}

describe('Групповой звонок: посторонний не входит в mesh', () => {
  it('добор по group_invite от чужого адреса не создаёт сессий', async () => {
    const { engine, states } = createEngine();
    engine.joinMesh('call-1', [SELF, PEER], 'audio');
    await engine.handleSignal(STRANGER, {
      type: 'group_invite', group_call_id: 'call-1', participants: [SELF, NEWBIE], media: 'audio',
    });
    // Сессия NEWBIE не создана: закрытие не последней сессии не заканчивает звонок
    engine.onSessionClosed(PEER);
    expect(engine.currentGroupCallId).toBeUndefined();
    expect(states).toEqual([]);
  });

  it('добор от участника звонка достраивает mesh', async () => {
    const { engine } = createEngine();
    engine.joinMesh('call-2', [SELF, PEER], 'audio');
    await engine.handleSignal(PEER, {
      type: 'group_invite', group_call_id: 'call-2', participants: [SELF, PEER, NEWBIE], media: 'audio',
    });
    engine.onSessionClosed(PEER);
    // NEWBIE остался — звонок идёт
    expect(engine.currentGroupCallId).toBe('call-2');
  });

  it('попарный invite постороннего отбрасывается', async () => {
    const { engine } = createEngine();
    engine.joinMesh('call-3', [SELF, PEER], 'audio');
    await engine.handleSignal(STRANGER, { type: 'invite', call_id: 'x', media: 'audio', sdp: 'v=0' });
    engine.onSessionClosed(PEER);
    expect(engine.currentGroupCallId).toBeUndefined();
  });
});
