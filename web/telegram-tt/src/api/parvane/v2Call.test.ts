import { describe, expect, it } from 'vitest';

import type { WireCallSignal } from './callengine';

import {
  callSignalFromV2, callSignalToV2, groupCallIdFromV2, groupInviteFromV2,
} from './v2/callMap';
import { decodeIceCandidate } from './iceCandidate';

// Сигнал личного звонка v1 ↔ v2 (spec 007 D-08): по v2 он идёт запечатанным
// конвертом, подпись SDP ключом звонков не передаётся — отправителя проверяет движок.

const CALL_ID = '01a0f945-1263-7d48-b3a1-ae3da31ccea9';
const SDP = 'candidate:1 1 udp 2122260223 127.0.0.1 5000 typ host';

function roundTrip(signal: WireCallSignal) {
  const v2 = callSignalToV2(signal);
  return v2 && callSignalFromV2(v2);
}

describe('v2: сигнал звонка', () => {
  it('оффер и ответ переносятся без подписи SDP', () => {
    const offer = callSignalToV2({
      type: 'invite', call_id: CALL_ID, media: 'video', sdp: 'v=0', sig: 'signature',
    });
    expect(offer).toMatchObject({ offer: { sdp: 'v=0', video: true } });
    expect(JSON.stringify(offer)).not.toContain('signature');
    expect(roundTrip({ type: 'invite', call_id: CALL_ID, media: 'audio', sdp: 'v=0' }))
      .toEqual({ type: 'invite', call_id: CALL_ID, media: 'audio', sdp: 'v=0' });
    expect(roundTrip({ type: 'answer', call_id: CALL_ID, sdp: 'v=1' }))
      .toEqual({ type: 'answer', call_id: CALL_ID, sdp: 'v=1' });
  });

  it('кандидат любого вида CALL-1 → IceCandidate и обратно', () => {
    const v2 = callSignalToV2({
      type: 'ice', call_id: CALL_ID, candidate: JSON.stringify({ sdp: SDP, mid: '0', idx: 0 }),
    });
    expect(v2?.ice).toEqual({ candidate: SDP, sdp_mid: '0', sdp_mline_index: 0 });
    // Движок отдаёт имена схемы или camelCase — читаем оба
    const back = callSignalFromV2({ callId: v2!.call_id, ice: { candidate: SDP, sdpMid: '0', sdpMlineIndex: 0 } });
    expect(back?.type).toBe('ice');
    expect(decodeIceCandidate((back as { candidate: string }).candidate))
      .toMatchObject({ candidate: SDP, sdpMid: '0', sdpMLineIndex: 0 });
  });

  it('отказ и отбой — через причину завершения', () => {
    expect(roundTrip({ type: 'reject', call_id: CALL_ID, reason: 'busy' }))
      .toEqual({ type: 'reject', call_id: CALL_ID, reason: 'busy' });
    expect(roundTrip({ type: 'reject', call_id: CALL_ID, reason: 'declined' }))
      .toEqual({ type: 'reject', call_id: CALL_ID, reason: 'declined' });
    expect(roundTrip({ type: 'hangup', call_id: CALL_ID })).toEqual({ type: 'hangup', call_id: CALL_ID });
    // Числовое значение enum и неизвестная причина
    const callId = callSignalToV2({ type: 'hangup', call_id: CALL_ID })!.call_id;
    expect(callSignalFromV2({ call_id: callId, hangup: { reason: 3 } }))
      .toEqual({ type: 'reject', call_id: CALL_ID, reason: 'busy' });
  });

  it('id звонка не UUID и пустой сигнал по v2 не идут', () => {
    expect(callSignalToV2({ type: 'hangup', call_id: 'not-a-uuid' })).toBeUndefined();
    expect(callSignalFromV2({ call_id: 'AAAA' })).toBeUndefined();
    expect(callSignalFromV2({ callId: callSignalToV2({ type: 'hangup', call_id: CALL_ID })!.call_id, ringing: {} }))
      .toBeUndefined();
  });

  // Групповой звонок (T141): приглашение и попарные сигналы mesh — запечатанными
  // конвертами; в v1 это отдельный инбокс `gcall:<адрес>`
  const GROUP_CALL_ID = '01a0f945-1263-7d48-b3a1-ae3da31ccee0';

  it('приглашение в групповой звонок → group_ring и обратно', () => {
    const invite = {
      type: 'group_invite' as const,
      group_call_id: GROUP_CALL_ID,
      participants: ['alice@local', 'bob@local', 'carol@local'],
      media: 'video' as const,
    };
    const v2 = callSignalToV2(invite);
    expect(v2?.group_ring).toEqual({
      participants: [{ address: 'alice@local' }, { address: 'bob@local' }, { address: 'carol@local' }],
      video: true,
    });
    expect(v2?.group_call_id).toBeUndefined();
    expect(groupInviteFromV2(v2!)).toEqual(invite);
    // Движок отдаёт camelCase
    expect(groupInviteFromV2({ callId: v2!.call_id, groupRing: v2!.group_ring })).toEqual(invite);
    expect(groupInviteFromV2({ call_id: v2!.call_id, offer: { sdp: 'v=0' } })).toBeUndefined();
    expect(callSignalToV2({ ...invite, group_call_id: 'not-a-uuid' })).toBeUndefined();
  });

  it('попарный сигнал mesh несёт id группового звонка', () => {
    const offer = callSignalToV2({
      type: 'invite', call_id: CALL_ID, media: 'audio', sdp: 'v=0', sig: 'signature',
    }, GROUP_CALL_ID);
    expect(offer).toMatchObject({ offer: { sdp: 'v=0', video: false } });
    expect(groupCallIdFromV2(offer!)).toBe(GROUP_CALL_ID);
    expect(callSignalFromV2(offer!)).toEqual({ type: 'invite', call_id: CALL_ID, media: 'audio', sdp: 'v=0' });
    expect(groupCallIdFromV2({ callId: offer!.call_id, groupCallId: offer!.group_call_id })).toBe(GROUP_CALL_ID);
    // Личный звонок: поля нет
    const direct = callSignalToV2({ type: 'hangup', call_id: CALL_ID });
    expect(groupCallIdFromV2(direct!)).toBeUndefined();
    expect(callSignalToV2({ type: 'hangup', call_id: CALL_ID }, 'not-a-uuid')).toBeUndefined();
  });
});
