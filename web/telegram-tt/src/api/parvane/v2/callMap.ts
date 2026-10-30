// Сигнал звонка v1 (`WireCallSignal`) ↔ v2 (`parvane.call.v2.CallSignal`,
// proto3-JSON). Личный звонок — сигналы как есть; групповой (mesh, T141) —
// приглашение `group_ring` и попарные сигналы с `group_call_id` (в v1 это
// отдельный инбокс `gcall:<адрес>`). Подписи SDP (`sig`) в v2 нет: операцию
// подписывает ключ устройства, а движок сверяет сертификат, аудиторию и
// привязку к звонку.
import type { WireCallSignal } from '../callengine';
import type { WireGroupInvite } from '../groupcall';

import { decodeIceCandidate, encodeIceCandidate } from '../iceCandidate';
import { base64ToBytes, bytesToBase64 } from './base64';
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
  mediaState?: V2MediaState;
  media_state?: V2MediaState;
  groupRing?: V2GroupRing;
  group_ring?: V2GroupRing;
  groupCallId?: string;
  group_call_id?: string;
};

type V2MediaState = { audioMuted?: boolean; audio_muted?: boolean; videoMuted?: boolean; video_muted?: boolean };

type V2GroupRing = {
  participants?: { address?: string }[];
  video?: boolean;
  group?: { domain?: string; id?: string };
  title?: string;
};

const GROUP_ADDRESS_REGEX = /^v2g:([0-9a-f]{2}){1,64}$/;
const GROUP_TITLE_MAX_BYTES = 255;

/** Название группы из сигнала: без управляющих и bidi-символов, ≤ 255 байт UTF-8 (`max_len` схемы). */
export function cleanGroupTitle(title: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const plain = (title || '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const encoder = new TextEncoder();
  let out = '';
  for (const ch of plain) {
    if (encoder.encode(out + ch).length > GROUP_TITLE_MAX_BYTES) break;
    out += ch;
  }
  return out.trim();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_NORMAL = 'HANGUP_REASON_NORMAL';
const REASON_DECLINED = 'HANGUP_REASON_DECLINED';
const REASON_BUSY = 'HANGUP_REASON_BUSY';
const REASON_MISSED = 'HANGUP_REASON_MISSED';
const REASON_FAILED = 'HANGUP_REASON_FAILED';
const REASON_ANSWERED_ELSEWHERE = 'HANGUP_REASON_ANSWERED_ELSEWHERE';
// Причины отказа v1 (`reject.reason`) → причина завершения v2
const REJECT_TO_V2: Record<string, string> = {
  declined: REASON_DECLINED,
  busy: REASON_BUSY,
  auth_failed: REASON_FAILED,
  media_failed: REASON_FAILED,
  answered_elsewhere: REASON_ANSWERED_ELSEWHERE,
};
// Числовые значения enum (pbjson отдаёт имена, но принимает и числа)
const REASON_BY_NUMBER = [
  undefined, REASON_NORMAL, REASON_DECLINED, REASON_BUSY, REASON_MISSED, REASON_FAILED, REASON_ANSWERED_ELSEWHERE,
];

/**
 * `undefined` — такой сигнал по v2 не передаётся (идёт v1-путём или отбрасывается).
 * `groupCallId` — сигнал попарного соединения внутри группового звонка.
 */
export function callSignalToV2(
  signal: WireCallSignal | WireGroupInvite, groupCallId?: string, domain?: string,
): V2CallSignal | undefined {
  if (signal.type === 'group_invite') {
    if (!UUID_REGEX.test(signal.group_call_id)) return undefined;
    const title = cleanGroupTitle(signal.title);
    const group = domain && signal.group && GROUP_ADDRESS_REGEX.test(signal.group)
      ? { domain, id: bytesToBase64(hexToBytes(signal.group.slice(4))) } : undefined;
    return {
      call_id: uuidToB64(signal.group_call_id),
      group_ring: {
        participants: signal.participants.map((address) => ({ address })),
        video: signal.media === 'video',
        ...(group && { group }),
        ...(title && { title }),
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
    case 'media':
      return {
        call_id: callId,
        media_state: { audio_muted: Boolean(signal.audio_muted), video_muted: Boolean(signal.video_muted) },
      };
    default:
      return undefined;
  }
}

/** Id группового звонка, к которому относится попарный сигнал; `undefined` — личный звонок. */
export function groupCallIdFromV2(signal: V2CallSignal): string | undefined {
  return b64ToUuid(signal.groupCallId || signal.group_call_id) || undefined;
}

const PARTICIPANT_MAX_LENGTH = 256;

/** Адреса участников приглашения: без пустых, без повторов, без заведомо негодных (не `имя@сервер`, с пробелами,
 * слишком длинных) — по списку устройство рассылает отказы. Число не режем: превышение лимита приём отвергает целиком. */
export function cleanParticipants(addresses: string[]): string[] {
  const seen = new Set<string>();
  addresses.forEach((address) => {
    if (!address || address.length > PARTICIPANT_MAX_LENGTH || /\s/.test(address) || !/^[^@]+@[^@]+$/.test(address)) {
      return;
    }
    seen.add(address);
  });
  return [...seen];
}

/** Приглашение в групповой звонок из события движка; `undefined` — другой сигнал. */
export function groupInviteFromV2(signal: V2CallSignal): WireGroupInvite | undefined {
  const ring = signal.groupRing || signal.group_ring;
  const groupCallId = b64ToUuid(signal.callId || signal.call_id);
  if (!ring || !groupCallId) return undefined;
  const groupId = ring.group?.id ? base64ToBytes(ring.group.id) : undefined;
  const title = cleanGroupTitle(ring.title);
  return {
    type: 'group_invite',
    group_call_id: groupCallId,
    participants: cleanParticipants((ring.participants || []).map(({ address }) => address || '')),
    media: ring.video ? 'video' : 'audio',
    ...(groupId?.length && groupId.length <= 64 && { group: `v2g:${bytesToHex(groupId)}` }),
    ...(title && { title }),
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
  const media = signal.mediaState || signal.media_state;
  if (media) {
    return {
      type: 'media',
      call_id: callId,
      audio_muted: Boolean(media.audioMuted ?? media.audio_muted),
      video_muted: Boolean(media.videoMuted ?? media.video_muted),
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
    if (reason === REASON_ANSWERED_ELSEWHERE) return { type: 'reject', call_id: callId, reason: 'answered_elsewhere' };
    return { type: 'hangup', call_id: callId };
  }
  return undefined;
}

function hexToBytes(hex: string) {
  return Uint8Array.from(hex.match(/../g) || [], (byte) => parseInt(byte, 16));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
