import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupPeerState } from './groupcall';

import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import { GROUP_CALL_MAX_PARTICIPANTS, GroupCallEngine } from './groupcall';

// Граничный случай спеки: «Групповой звонок достигает лимита участников (8):
// девятый получает отказ». Отказ есть в двух местах — при СОЗДАНИИ звонка
// (calls.ts: placeGroupCall не пускает группу, где активных больше лимита) и
// при ДОБОРЕ участников в идущий звонок (groupcall.ts: joinMesh). Здесь
// закрыты обе ветки.
//
// Все адреса подобраны так, что `self` лексикографически БОЛЬШЕ любого пира:
// оффер шлёт меньший адрес (glare-разрешение), поэтому startOffer не
// вызывается и RTCPeerConnection в jsdom не нужен.
const SELF = 'zoe@bubble';
const peerAt = (index: number) => `p${String(index).padStart(2, '0')}@bubble`;

function createEngine() {
  const tooManyEvents: number[] = [];
  const onTooMany = (event: Event) => {
    tooManyEvents.push((event as CustomEvent<{ limit: number }>).detail.limit);
  };
  window.addEventListener('parvane-call-too-many', onTooMany);

  let endedCount = 0;
  const engine = new GroupCallEngine(SELF, {
    sendSignal: () => undefined,
    getPeerSigningKeys: () => Promise.resolve([]),
    getIceServers: () => Promise.resolve([]),
    getIceTransportPolicy: () => undefined,
    sign: () => 'sig',
    verify: () => true,
    onPeerState: () => undefined,
    onPeerStream: () => undefined,
    onEnded: () => {
      endedCount += 1;
    },
  });

  // Единственный публичный признак «сессия есть» — onEnded, который движок
  // шлёт при закрытии ПОСЛЕДНЕЙ сессии. Закрываем кандидатов по одному и
  // смотрим, после какого по счёту звонок объявлен законченным: это и есть
  // число реально созданных сессий.
  const countSessions = (candidates: string[]) => {
    const before = endedCount;
    let sessions = 0;
    candidates.forEach((peer, index) => {
      engine.onSessionClosed(peer);
      if (endedCount > before && !sessions) sessions = index + 1;
    });
    return sessions;
  };

  const dispose = () => window.removeEventListener('parvane-call-too-many', onTooMany);

  return { engine, tooManyEvents, countSessions, dispose };
}

describe('Лимит участников группового звонка (граничный случай «девятый получает отказ»)', () => {
  let ctx: ReturnType<typeof createEngine>;

  beforeEach(() => {
    ctx = createEngine();
  });
  afterEach(() => ctx.dispose());

  it('звонок ровно на лимит (self + 7) собирается целиком и без отказа', () => {
    const peers = Array.from({ length: 7 }, (_, i) => peerAt(i));
    ctx.engine.joinMesh('call-1', [SELF, ...peers], 'audio');

    expect(ctx.tooManyEvents).toEqual([]);
    expect(ctx.countSessions(peers)).toBe(7);
  });

  it('девятый участник в списке приглашения отсекается, а не достраивает mesh', () => {
    const peers = Array.from({ length: 8 }, (_, i) => peerAt(i));
    ctx.engine.joinMesh('call-2', [SELF, ...peers], 'audio');

    // Ровно один отказ с лимитом из константы — он же показывается тостом
    expect(ctx.tooManyEvents).toEqual([GROUP_CALL_MAX_PARTICIPANTS]);
    // Сессий 7 (self восьмой), девятый участник сессии не получил
    expect(ctx.countSessions(peers)).toBe(7);
  });

  it('добор в ИДУЩИЙ звонок тоже упирается в лимит', () => {
    const peers = Array.from({ length: 7 }, (_, i) => peerAt(i));
    ctx.engine.joinMesh('call-3', [SELF, ...peers], 'audio');
    expect(ctx.tooManyEvents).toEqual([]);

    // Тот же звонок, в списке появился ещё один участник
    const latecomer = peerAt(7);
    ctx.engine.joinMesh('call-3', [SELF, ...peers, latecomer], 'audio');

    expect(ctx.tooManyEvents).toEqual([GROUP_CALL_MAX_PARTICIPANTS]);
    expect(ctx.countSessions([...peers, latecomer])).toBe(7);
  });

  it('создание звонка: группа из 9 активных отказывается, из 8 — нет', () => {
    // Условие отказа в calls.ts: getActiveGroupMemberAddresses(info.members).length
    // > GROUP_CALL_MAX_PARTICIPANTS
    const members = (count: number, banned = 0) => [
      ...Array.from({ length: count }, (_, i) => ({ address: peerAt(i), role: 'member' })),
      ...Array.from({ length: banned }, (_, i) => ({ address: peerAt(90 + i), role: 'banned' })),
    ];

    expect(getActiveGroupMemberAddresses(members(8)).length > GROUP_CALL_MAX_PARTICIPANTS).toBe(false);
    expect(getActiveGroupMemberAddresses(members(9)).length > GROUP_CALL_MAX_PARTICIPANTS).toBe(true);
    // Забаненные лимит не съедают: 8 активных + 5 забаненных звонку не мешают
    expect(getActiveGroupMemberAddresses(members(8, 5)).length > GROUP_CALL_MAX_PARTICIPANTS).toBe(false);
  });
});

// Наблюдаемые события движка: состояния строк участников и конец звонка
function createObservedEngine() {
  const peerStates: Array<[string, GroupPeerState]> = [];
  let endedCount = 0;
  const engine = new GroupCallEngine(SELF, {
    sendSignal: () => undefined,
    getPeerSigningKeys: () => Promise.resolve([]),
    getIceServers: () => Promise.resolve([]),
    getIceTransportPolicy: () => undefined,
    sign: () => 'sig',
    verify: () => true,
    onPeerState: (peer, state) => {
      peerStates.push([peer, state]);
    },
    onPeerStream: () => undefined,
    onEnded: () => {
      endedCount += 1;
    },
  });
  return { engine, peerStates, endedCount: () => endedCount };
}

describe('Отказ в доступе к устройствам не кэшируется на всю сессию', () => {
  const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  const mockGetUserMedia = (getUserMedia: unknown) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia }, configurable: true, writable: true,
    });
  };

  afterEach(() => {
    if (originalDevices) Object.defineProperty(navigator, 'mediaDevices', originalDevices);
    else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  it('после отказа следующий звонок снова спрашивает устройства', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new Error('NotAllowedError'))
      .mockResolvedValueOnce(stream);
    mockGetUserMedia(getUserMedia);
    const { engine } = createObservedEngine();

    // Отказ: поток не поднялся, но и не запомнился навсегда — иначе каждый
    // следующий групповой звонок во вкладке самоотклонялся бы
    expect(await engine.ensureLocalStream('audio')).toBeUndefined();
    expect(await engine.ensureLocalStream('audio')).toBe(stream);
    expect(engine.getLocalStream()).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('успешный поток по-прежнему один на звонок', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    mockGetUserMedia(getUserMedia);
    const { engine } = createObservedEngine();

    const [first, second] = await Promise.all([
      engine.ensureLocalStream('audio'), engine.ensureLocalStream('audio'),
    ]);
    expect(first).toBe(stream);
    expect(second).toBe(stream);
    expect(await engine.ensureLocalStream('audio')).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('Отказ участника, которому мы ещё не слали оффер (правило glare)', () => {
  // Адрес пира меньше SELF, поэтому оффер за ним: своего call_id у нашей
  // сессии нет, и отказ приходит с чужим идентификатором
  const PEER = peerAt(1);

  it('reject{declined} закрывает строку, а не ждёт таймаута вызова', async () => {
    const ctx = createObservedEngine();
    ctx.engine.joinMesh('call-reject', [SELF, PEER], 'audio');

    await ctx.engine.handleSignal(PEER, { type: 'reject', call_id: 'his-own-id', reason: 'declined' });

    expect(ctx.peerStates).toContainEqual([PEER, 'ended']);
    expect(ctx.endedCount()).toBe(1);
  });

  it('reject{busy} помечает строку «занят»', async () => {
    const ctx = createObservedEngine();
    ctx.engine.joinMesh('call-busy', [SELF, PEER], 'audio');

    await ctx.engine.handleSignal(PEER, { type: 'reject', call_id: 'his-own-id', reason: 'busy' });

    expect(ctx.peerStates).toContainEqual([PEER, 'busy']);
    expect(ctx.endedCount()).toBe(1);
  });
});
