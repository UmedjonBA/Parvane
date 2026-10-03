// Сигнал звонка v1 (`WireCallSignal`) ↔ v2 (`parvane.call.v2.CallSignal`,
// proto3-JSON). Личный звонок — сигналы как есть; групповой (mesh, T141) —
// приглашение `group_ring` и попарные сигналы с `group_call_id` (в v1 это
// отдельный инбокс `gcall:<адрес>`). Подписи SDP (`sig`) в v2 нет: операцию
// подписывает ключ устройства, а движок сверяет сертификат, аудиторию и
// привязку к звонку.
import type { WireCallSignal } from '../callengine';
import type { WireGroupInvite } from '../groupcall';

import { decodeIceCandidate, encodeIceCandidate } from '../iceCandidate';
import { b64ToUuid, uuidToB64 } from './contentMap';

type V2Hangup = { reason?: string | number; durationS?: number; duration_s?: number };

export type V2CallSignal = {
  callId?: string;
  call_id?: string;
  offer?: { sdp?: string; video?: boolean };
  answer?: { sdp?: string };
  ice?: {
    candidate?: string;
    sdpMid?: string;
    sdp_mid?: string;
    sdpMlineIndex?: number;
    sdp_mline_index?: number;
  };
  hangup?: V2Hangup;
  ringing?: Record<string, never>;
  groupRing?: V2GroupRing;
  group_ring?: V2GroupRing;
  groupCallId?: string;
  group_call_id?: string;
};

type V2GroupRing = { participants?: { address?: string }[]; video?: boolean };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_NORMAL = 'HANGUP_REASON_NORMAL';
const REASON_DECLINED = 'HANGUP_REASON_DECLINED';
const REASON_BUSY = 'HANGUP_REASON_BUSY';
const REASON_MISSED = 'HANGUP_REASON_MISSED';
const REASON_FAILED = 'HANGUP_REASON_FAILED';
// Причины отказа v1 (`reject.reason`) → причина завершения v2
const REJECT_TO_V2: Record<string, string> = {
  declined: REASON_DECLINED,
  busy: REASON_BUSY,
  auth_failed: REASON_FAILED,
  media_failed: REASON_FAILED,
};
// Числовые значения enum (pbjson отдаёт имена, но принимает и числа)
const REASON_BY_NUMBER = [undefined, REASON_NORMAL, REASON_DECLINED, REASON_BUSY, REASON_MISSED, REASON_FAILED];

/**
 * `undefined` — такой сигнал по v2 не передаётся (идёт v1-путём или отбрасывается).
 * `groupCallId` — сигнал попарного соединения внутри группового звонка.
 */
export function callSignalToV2(
  signal: WireCallSignal | WireGroupInvite, groupCallId?: string,
): V2CallSignal | undefined {
  if (signal.type === 'group_invite') {
    if (!UUID_REGEX.test(signal.group_call_id)) return undefined;
    return {
      call_id: uuidToB64(signal.group_call_id),
      group_ring: {
        participants: signal.participants.map((address) => ({ address })),
        video: signal.media === 'video',
      },
    };
  }
  if (groupCallId !== undefined) {
    if (!UUID_REGEX.test(groupCallId)) return undefined;
    const pair = callSignalToV2(signal);
    return pair && { ...pair, group_call_id: uuidToB64(groupCallId) };
  }
  // id звонка в v2 — 16 байт: по v2 идут только звонки с UUID
  if (!UUID_REGEX.test(signal.call_id)) return undefined;
  const callId = uuidToB64(signal.call_id);
  switch (signal.type) {
    case 'invite':
      return { call_id: callId, offer: { sdp: signal.sdp, video: signal.media === 'video' } };
    case 'answer':
      return { call_id: callId, answer: { sdp: signal.sdp } };
    case 'ice': {
      const candidate = decodeIceCandidate(signal.candidate);
      if (!candidate?.candidate) return undefined;
      return {
        call_id: callId,
        ice: {
          candidate: candidate.candidate,
          sdp_mid: candidate.sdpMid || '',
          sdp_mline_index: candidate.sdpMLineIndex || 0,
        },
      };
    }
    case 'reject':
      return { call_id: callId, hangup: { reason: REJECT_TO_V2[signal.reason || ''] || REASON_DECLINED } };
    case 'hangup':
      return { call_id: callId, hangup: { reason: REASON_NORMAL } };
    default:
      return undefined;
  }
}

/** Id группового звонка, к которому относится попарный сигнал; `undefined` — личный звонок. */
export function groupCallIdFromV2(signal: V2CallSignal): string | undefined {
  return b64ToUuid(signal.groupCallId || signal.group_call_id) || undefined;
}

/** Приглашение в групповой звонок из события движка; `undefined` — другой сигнал. */
export function groupInviteFromV2(signal: V2CallSignal): WireGroupInvite | undefined {
  const ring = signal.groupRing || signal.group_ring;
  const groupCallId = b64ToUuid(signal.callId || signal.call_id);
  if (!ring || !groupCallId) return undefined;
  return {
    type: 'group_invite',
    group_call_id: groupCallId,
    participants: (ring.participants || []).map(({ address }) => address || '').filter(Boolean),
    media: ring.video ? 'video' : 'audio',
  };
}

/** Событие движка `call` → сигнал для движка звонков; `undefined` — нечего передавать. */
export function callSignalFromV2(signal: V2CallSignal): WireCallSignal | undefined {
  const callId = b64ToUuid(signal.callId || signal.call_id);
  if (!callId) return undefined;
  if (signal.offer) {
    return {
      type: 'invite', call_id: callId, media: signal.offer.video ? 'video' : 'audio', sdp: signal.offer.sdp || '',
    };
  }
  if (signal.answer) return { type: 'answer', call_id: callId, sdp: signal.answer.sdp || '' };
  if (signal.ice) {
    if (!signal.ice.candidate) return undefined;
    return {
      type: 'ice',
      call_id: callId,
      candidate: encodeIceCandidate({
        candidate: signal.ice.candidate,
        sdpMid: signal.ice.sdpMid ?? signal.ice.sdp_mid ?? '',
        sdpMLineIndex: signal.ice.sdpMlineIndex ?? signal.ice.sdp_mline_index ?? 0,
      }),
    };
  }
  if (signal.hangup) {
    const raw = signal.hangup.reason;
    const reason = typeof raw === 'number' ? REASON_BY_NUMBER[raw] : raw;
    if (reason === REASON_BUSY) return { type: 'reject', call_id: callId, reason: 'busy' };
    if (reason === REASON_DECLINED || reason === REASON_MISSED) {
      return { type: 'reject', call_id: callId, reason: 'declined' };
    }
    if (reason === REASON_FAILED) return { type: 'reject', call_id: callId, reason: 'media_failed' };
    return { type: 'hangup', call_id: callId };
  }
  return undefined;
}
