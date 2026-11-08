// Протокол v2 (spec 007, E2; spec 035 T114, ENGINE-1): содержимое движка (proto3-JSON `parvane.msg.v2.Content`) ↔
// внутреннее содержимое провайдера (WireMessageContent — то, что рисует store/UI). Виды содержимого разбирает и
// собирает ТОЛЬКО движок (`views.rs`: `contentView`, `contentOfWire`) — одно правило для web, desktop и android;
// здесь — типы границы и id сообщений.

import type { WireMessageContent } from '../wire';

import { historyStatic } from './engine';

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
  content_hash?: string; contentHash?: string;
  blob_domain?: string; blobDomain?: string;
};
export type V2Media = {
  blob_domain?: string;
  blobDomain?: string;
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
  album_id?: string;
  title?: string;
  performer?: string;
  capability?: string;
};
export type V2Text = {
  text?: string;
  entities?: V2Entity[];
  preview?: { url?: string; site_name?: string; title?: string; description?: string; image?: V2Media };
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
    // int64 в JSON движка — строкой
    close_ms?: string | number; no_revote?: boolean; shuffle?: boolean; hide_results?: boolean;
  };
  poll_vote?: {
    poll?: V2MessageRef; option_indexes?: number[]; tally?: boolean; counts?: number[]; voters?: number;
  };
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
  // spec 016 (CLOUD-1): приглашение в совместную папку облака
  cloud_invite?: { container?: { domain?: string; id?: string }; name?: string; role?: number; text?: string };
  // ARTICLE-1: статья — заметка в Markdown
  article?: { title?: string; markdown?: string; text?: string; media?: V2Media[] };
  mod_report?: {
    group?: { domain?: string; id?: string };
    reason?: string;
    comment?: string;
    text?: string;
    messages?: {
      op_id?: string; author?: { address?: string }; text?: string; ts_ms?: string | number; proof?: string;
    }[];
  };
  // Режим «усиленная приватность» (L2, FR-036): предпочтение участника
  // личного чата; proto3-JSON опускает `l2: false`
  chat_mode?: { l2?: boolean };
  ttl_secs?: number;
  reply_to?: V2MessageRef;
  forward?: { from_user?: { address: string }; from_name?: string };
  silent?: boolean;
  // MEDIA-2, QUOTE-1
  invert_media?: boolean;
  reply_quote?: { text?: string; entities?: V2Entity[]; offset?: number };
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

// ── разбор и сборка — движок ───────────────────────────────────────────────

export type V2Class = 'message' | 'mutation' | 'service' | 'stub';

/** Мутация, разобранная движком: цели — UUID сообщений. */
export type ContentMutation =
  | {
    kind: 'edit';
    target: string;
    patch: Partial<Pick<WireMessageContent, 'text' | 'entities' | 'webpage'>>
      & { fields?: Partial<WireMessageContent> };
  }
  | { kind: 'delete'; targets: string[]; forEveryone: boolean }
  | { kind: 'reaction'; target: string; emoji: string }
  | { kind: 'pin'; target: string; pinned: boolean }
  | { kind: 'receipt'; read: boolean; targets: string[] };

/** Что содержимое значит для клиента (движок `content_view`): класс (векторы `content/kinds.json`), строка
 * формата экспорта для сообщения, UUID ответа, разобранная мутация. Его же несут события движка (`ev.view`). */
export type ContentView = {
  class: V2Class;
  wire?: WireMessageContent;
  replyTo?: string;
  mutation?: ContentMutation;
};

export function contentView(c: V2Content): ContentView {
  return historyStatic<ContentView>('contentView', { content: c });
}

/** Внутреннее содержимое UI → Content движка (движок `wire_to_content`); неизвестный вид — исключение. */
export function contentOfWire(c: WireMessageContent, replyTo?: string): V2Content {
  return historyStatic<V2Content>('contentOfWire', replyTo ? { wire: c, replyTo } : { wire: c });
}

/** Content движка → внутреннее содержимое UI; undefined — не сообщение (мутация, служебное, заглушка). */
export function wireOfContent(c: V2Content): WireMessageContent | undefined {
  return contentView(c).wire;
}

/** Строка не длиннее `maxBytes` байт UTF-8, без разрыва символа (предел `max_len` схемы — в байтах). */
export function truncateUtf8(value: string, maxBytes: number) {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

export function isWebUrl(value: string) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
