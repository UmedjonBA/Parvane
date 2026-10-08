// Протокол v2 (spec 007, E2): отображение содержимого движка (proto3-JSON
// `parvane.msg.v2.Content`, его выдаёт/принимает WASM-движок) ↔ внутреннее
// содержимое провайдера (WireMessageContent — то, что рисует store/UI).
// Это НЕ разбор протокола: байты провода разбирает только движок; здесь —
// перекладка полей уже проверенного движком объекта в модель UI.

import type { WireMessageContent, WirePackRef, WireTextEntity } from '../wire';

// proto3-JSON: имена полей как в схеме, enum — строками, bytes — base64,
// 64-битные — строками.
export type V2Entity = {
  type: string;
  offset?: number;
  length?: number;
  url?: string;
  user?: { address: string };
  language?: string;
  custom_emoji_id?: string;
};
export type V2PackRef = {
  file_id?: string; name?: string; count?: number; key?: string; nonce?: string; capability?: string;
};
export type V2Media = {
  kind: string;
  file_id?: string;
  mime?: string;
  size?: string;
  duration_ms?: number;
  width?: number;
  height?: number;
  waveform?: string;
  file_key?: string;
  file_nonce?: string;
  name?: string;
  caption?: string;
  caption_entities?: V2Entity[];
  thumbnail?: string;
  spoiler?: boolean;
  title?: string;
  performer?: string;
  capability?: string;
};
export type V2Text = {
  text?: string;
  entities?: V2Entity[];
  preview?: { url?: string; site_name?: string; title?: string; description?: string };
  emoji_packs?: V2PackRef[];
};
export type V2Location = {
  latitude?: number; longitude?: number; accuracy_m?: number; live_period_s?: number; heading?: number;
  title?: string; address?: string;
};
export type V2MessageRef = { op_id?: string };
export type V2TaskOffer = {
  name?: string; description?: string; steps?: { text?: string }[]; day?: string; start?: string;
  minutes?: number; due?: string; text?: string;
};
export type V2Content = {
  text?: V2Text;
  media?: V2Media;
  sticker?: { pack?: string; sticker_id?: string; emoji?: string; media?: V2Media; pack_ref?: V2PackRef };
  location?: V2Location;
  poll?: {
    question?: string; options?: { text?: string }[]; is_public?: boolean; is_multiple?: boolean;
    is_quiz?: boolean; correct?: number[]; solution?: string;
  };
  poll_vote?: { poll?: V2MessageRef; option_indexes?: number[] };
  poll_close?: { poll?: V2MessageRef };
  receipt?: { kind?: string; messages?: V2MessageRef[] };
  edit?: { target?: V2MessageRef; text?: V2Text; location?: V2Location };
  delete?: { targets?: V2MessageRef[]; for_everyone?: boolean };
  reaction?: { target?: V2MessageRef; emoji?: string; remove?: boolean };
  pin?: { target?: V2MessageRef; unpin?: boolean; silent?: boolean };
  contact?: { first_name?: string; last_name?: string; phone?: string; user?: { address: string } };
  // spec 011 (TASK-1): задание в чат и решение по нему
  task_offer?: V2TaskOffer;
  task_response?: { offer?: V2MessageRef; decision?: string; text?: string };
  // Режим «усиленная приватность» (L2, FR-036): предпочтение участника
  // личного чата; proto3-JSON опускает `l2: false`
  chat_mode?: { l2?: boolean };
  ttl_secs?: number;
  reply_to?: V2MessageRef;
  forward?: { from_user?: { address: string }; from_name?: string };
  silent?: boolean;
};

// ── UUID ↔ base64 (id сообщений: UUIDv7 в UI, 16 байт в протоколе) ─────────

export function uuidToB64(uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

export function b64ToUuid(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return undefined;
  }
  if (bin.length !== 16) return undefined;
  const hex = Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const ref = (uuid: string): V2MessageRef => ({ op_id: uuidToB64(uuid) });

// ── entities ────────────────────────────────────────────────────────────────

const ENTITY_TO_V2: Record<string, string> = {
  bold: 'ENTITY_TYPE_BOLD',
  italic: 'ENTITY_TYPE_ITALIC',
  underline: 'ENTITY_TYPE_UNDERLINE',
  strike: 'ENTITY_TYPE_STRIKE',
  spoiler: 'ENTITY_TYPE_SPOILER',
  code: 'ENTITY_TYPE_CODE',
  pre: 'ENTITY_TYPE_PRE',
  text_url: 'ENTITY_TYPE_TEXT_URL',
  url: 'ENTITY_TYPE_URL',
  mention: 'ENTITY_TYPE_MENTION',
  blockquote: 'ENTITY_TYPE_BLOCKQUOTE',
  custom_emoji: 'ENTITY_TYPE_CUSTOM_EMOJI',
};
const ENTITY_FROM_V2 = Object.fromEntries(Object.entries(ENTITY_TO_V2).map(([k, v]) => [v, k]));

function entitiesToV2(list?: WireTextEntity[]): V2Entity[] | undefined {
  if (!list?.length) return undefined;
  return list.flatMap((e) => {
    const type = ENTITY_TO_V2[e.type];
    if (!type) return [];
    const out: V2Entity = { type, offset: e.offset, length: e.length };
    if (e.type === 'text_url') out.url = e.data;
    if (e.type === 'pre' && e.data) out.language = e.data;
    if (e.type === 'custom_emoji') out.custom_emoji_id = e.data;
    return [out];
  });
}

function entitiesFromV2(list?: V2Entity[]): WireTextEntity[] | undefined {
  if (!list?.length) return undefined;
  const out = list.flatMap((e): WireTextEntity[] => {
    const type = ENTITY_FROM_V2[e.type];
    if (!type) return [];
    const data = e.url || e.language || e.custom_emoji_id || undefined;
    return [{
      type, offset: e.offset || 0, length: e.length || 0, ...(data ? { data } : {}),
    }];
  });
  return out.length ? out : undefined;
}

const packToV2 = (p?: WirePackRef): V2PackRef | undefined => (p ? {
  file_id: p.file_id, name: p.name, count: p.count, key: p.key, nonce: p.nonce, capability: p.capability,
} : undefined);

const packFromV2 = (p?: V2PackRef): WirePackRef | undefined => (p?.file_id ? {
  file_id: p.file_id,
  name: p.name || '',
  count: p.count || 0,
  key: p.key || '',
  nonce: p.nonce || '',
  capability: p.capability || undefined,
} : undefined);

// ── waveform: number[] (0..31) ↔ bytes ─────────────────────────────────────

function waveToB64(w?: number[]): string | undefined {
  if (!w?.length) return undefined;
  return btoa(String.fromCharCode(...w.map((x) => Math.max(0, Math.min(255, x)))));
}

function waveFromB64(b?: string): number[] | undefined {
  if (!b) return undefined;
  try {
    return Array.from(atob(b), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

// ── медиа ───────────────────────────────────────────────────────────────────

const MEDIA_KIND: Record<string, string> = {
  photo: 'MEDIA_KIND_PHOTO',
  video: 'MEDIA_KIND_VIDEO',
  voice: 'MEDIA_KIND_VOICE',
  video_note: 'MEDIA_KIND_VIDEO_NOTE',
  gif: 'MEDIA_KIND_ANIMATION',
  file: 'MEDIA_KIND_FILE',
};

function mediaToV2(c: WireMessageContent): V2Media {
  const isAudio = c.kind === 'file' && (c.mime || '').startsWith('audio/');
  return {
    kind: isAudio ? 'MEDIA_KIND_AUDIO' : MEDIA_KIND[c.kind] || 'MEDIA_KIND_FILE',
    file_id: c.file_id,
    mime: c.mime,
    size: c.size_bytes !== undefined ? String(c.size_bytes) : undefined,
    duration_ms: c.duration_secs !== undefined ? Math.round(c.duration_secs * 1000) : undefined,
    width: c.width,
    height: c.height,
    waveform: waveToB64(c.waveform),
    file_key: c.file_key,
    file_nonce: c.file_nonce,
    name: c.filename,
    caption: c.caption || undefined,
    caption_entities: entitiesToV2(c.entities),
    title: c.audio_title,
    performer: c.audio_performer,
    capability: c.capability,
  };
}

const MEDIA_WIRE: Record<string, string> = {
  MEDIA_KIND_PHOTO: 'photo',
  MEDIA_KIND_VIDEO: 'video',
  MEDIA_KIND_VOICE: 'voice',
  MEDIA_KIND_VIDEO_NOTE: 'video_note',
  MEDIA_KIND_ANIMATION: 'gif',
  MEDIA_KIND_FILE: 'file',
  MEDIA_KIND_AUDIO: 'file',
};

function mediaFromV2(m: V2Media): WireMessageContent {
  const out: WireMessageContent = {
    kind: MEDIA_WIRE[m.kind] || 'file',
    file_id: m.file_id,
    mime: m.mime,
    size_bytes: m.size !== undefined ? Number(m.size) : undefined,
    duration_secs: m.duration_ms ? Math.max(1, Math.round(m.duration_ms / 1000)) : undefined,
    width: m.width,
    height: m.height,
    waveform: waveFromB64(m.waveform),
    file_key: m.file_key,
    file_nonce: m.file_nonce,
    filename: m.name,
    caption: m.caption || undefined,
    entities: entitiesFromV2(m.caption_entities),
    audio_title: m.title || undefined,
    audio_performer: m.performer || undefined,
    capability: m.capability || undefined,
  };
  return prune(out);
}

function prune<T extends Record<string, unknown>>(o: T): T {
  Object.keys(o).forEach((k) => {
    if (o[k] === undefined) delete o[k];
  });
  return o;
}

// ── содержимое ─────────────────────────────────────────────────────────────

/// Внутреннее содержимое UI → Content движка.
export function wireToV2(c: WireMessageContent, replyTo?: string): V2Content {
  let out: V2Content;
  switch (c.kind) {
    case 'text':
      out = {
        text: {
          text: c.text || '',
          entities: entitiesToV2(c.entities),
          preview: c.webpage ? {
            url: c.webpage.url,
            site_name: c.webpage.site_name,
            title: c.webpage.title,
            description: c.webpage.description,
          } : undefined,
          emoji_packs: c.emoji_packs?.map(packToV2).filter(Boolean),
        },
      };
      break;
    case 'photo': case 'video': case 'voice': case 'video_note': case 'gif': case 'file':
      out = { media: mediaToV2(c) };
      break;
    case 'sticker':
      out = {
        sticker: {
          pack: c.pack_ref?.name,
          sticker_id: c.file_id,
          emoji: c.filename,
          media: { ...mediaToV2({ ...c, kind: 'photo' }), caption: undefined },
          pack_ref: packToV2(c.pack_ref),
        },
      };
      break;
    case 'location':
      out = {
        location: {
          latitude: c.lat, longitude: c.long, live_period_s: c.live_period, heading: c.heading, accuracy_m: c.accuracy,
        },
      };
      break;
    case 'poll':
      out = {
        poll: {
          question: c.question,
          options: (c.options as string[] | undefined)?.map((text) => ({ text })),
          is_public: c.is_public,
          is_multiple: c.is_multiple,
          is_quiz: c.is_quiz,
          correct: c.correct,
          solution: c.solution,
        },
      };
      break;
    case 'poll_vote':
      out = {
        poll_vote: {
          poll: c.poll ? ref(c.poll) : undefined,
          option_indexes: (c.options as number[] | undefined) || [],
        },
      };
      break;
    case 'poll_close':
      out = { poll_close: { poll: c.poll ? ref(c.poll) : undefined } };
      break;
    case 'task_offer':
      out = {
        task_offer: {
          name: c.name,
          description: c.description || undefined,
          steps: c.steps?.map((text) => ({ text })),
          day: c.day || undefined,
          start: c.start || undefined,
          minutes: c.minutes || undefined,
          due: c.due || undefined,
          text: c.text || undefined,
        },
      };
      break;
    case 'task_response':
      out = {
        task_response: {
          offer: c.offer ? ref(c.offer) : undefined,
          decision: c.accepted ? 'TASK_DECISION_ACCEPTED' : 'TASK_DECISION_DECLINED',
          text: c.text || undefined,
        },
      };
      break;
    default:
      throw new Error(`v2: вид содержимого ${c.kind} не поддерживается`);
  }
  if (c.ttl_secs) out.ttl_secs = c.ttl_secs;
  if (replyTo) out.reply_to = ref(replyTo);
  if (c.forwarded_from || c.forwarded_name) {
    out.forward = {
      from_user: c.forwarded_from ? { address: c.forwarded_from } : undefined,
      from_name: c.forwarded_name,
    };
  }
  return out;
}

/// Content движка → внутреннее содержимое UI; undefined — не «сообщение»
/// (мутация/служебное — обрабатываются отдельно).
export function v2ToWire(c: V2Content): WireMessageContent | undefined {
  let out: WireMessageContent | undefined;
  if (c.text) {
    out = {
      kind: 'text',
      text: c.text.text || '',
      entities: entitiesFromV2(c.text.entities),
      webpage: c.text.preview?.url ? {
        url: c.text.preview.url,
        site_name: c.text.preview.site_name,
        title: c.text.preview.title,
        description: c.text.preview.description,
      } : undefined,
      emoji_packs: c.text.emoji_packs?.map(packFromV2).filter(Boolean),
    };
  } else if (c.media) {
    out = mediaFromV2(c.media);
  } else if (c.sticker) {
    const m = c.sticker.media ? mediaFromV2(c.sticker.media) : { kind: 'photo' } as WireMessageContent;
    out = {
      ...m, kind: 'sticker', filename: c.sticker.emoji || m.filename, pack_ref: packFromV2(c.sticker.pack_ref),
    };
  } else if (c.location) {
    out = {
      kind: 'location',
      lat: c.location.latitude,
      long: c.location.longitude,
      live_period: c.location.live_period_s || undefined,
      heading: c.location.heading || undefined,
      accuracy: c.location.accuracy_m || undefined,
    };
  } else if (c.poll) {
    out = {
      kind: 'poll',
      question: c.poll.question,
      options: c.poll.options?.map((o) => o.text || '') || [],
      is_public: c.poll.is_public || undefined,
      is_multiple: c.poll.is_multiple || undefined,
      is_quiz: c.poll.is_quiz || undefined,
      correct: c.poll.correct,
      solution: c.poll.solution || undefined,
    };
  } else if (c.poll_vote) {
    out = { kind: 'poll_vote', poll: b64ToUuid(c.poll_vote.poll?.op_id), options: c.poll_vote.option_indexes || [] };
  } else if (c.poll_close) {
    out = { kind: 'poll_close', poll: b64ToUuid(c.poll_close.poll?.op_id) };
  } else if (c.chat_mode) {
    // Служебное сообщение чата; `l2: false` значимо (режим выключен)
    out = { kind: 'chat_mode', l2: Boolean(c.chat_mode.l2) };
  } else if (c.task_offer) {
    out = {
      kind: 'task_offer',
      name: c.task_offer.name || '',
      description: c.task_offer.description || undefined,
      steps: c.task_offer.steps?.map((s) => s.text || '').filter(Boolean),
      day: c.task_offer.day || undefined,
      start: c.task_offer.start || undefined,
      minutes: c.task_offer.minutes || undefined,
      due: c.task_offer.due || undefined,
      text: c.task_offer.text || undefined,
    };
  } else if (c.task_response) {
    out = {
      kind: 'task_response',
      offer: b64ToUuid(c.task_response.offer?.op_id),
      accepted: c.task_response.decision === 'TASK_DECISION_ACCEPTED',
      text: c.task_response.text || undefined,
    };
  }
  if (!out) return undefined;
  if (c.ttl_secs) out.ttl_secs = c.ttl_secs;
  if (c.forward) {
    out.forwarded_from = c.forward.from_user?.address;
    out.forwarded_name = c.forward.from_name;
  }
  return prune(out as Record<string, unknown>) as WireMessageContent;
}

export type V2Class = 'message' | 'mutation' | 'service' | 'stub';

const MUTATION_KINDS = ['receipt', 'edit', 'delete', 'reaction', 'pin'];
const SERVICE_KINDS = ['call', 'group_key', 'delivery_key', 'container_key', 'state_key'];

/// Чем содержимое является для клиента — одинаково во всех клиентах (векторы
/// `proto/parvane/vectors/content/kinds.json`): сообщение чата, мутация или
/// квитанция, служебное движка, либо вид, который клиент не умеет показать
/// (или пустое содержимое), — нативная заглушка «не поддерживается».
export function v2Class(c: V2Content): V2Class {
  const fields = c as Record<string, unknown>;
  const has = (k: string) => fields[k] !== undefined;
  if (MUTATION_KINDS.some(has)) return 'mutation';
  if (SERVICE_KINDS.some(has)) return 'service';
  return v2ToWire(c) ? 'message' : 'stub';
}
