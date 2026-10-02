// Форматирование текста: маппинг между wire-entities (короткие имена, как в
// десктопе: bold/italic/…/text_url) и ApiMessageEntity tt. offset/length в
// UTF-16 — одинаково у обоих, прямой проброс.

import type { ApiMessageEntity } from '../types';
import type { WireTextEntity } from './wire';
import { ApiMessageEntityTypes } from '../types';

const WIRE_TO_API: Record<string, ApiMessageEntityTypes> = {
  bold: ApiMessageEntityTypes.Bold,
  italic: ApiMessageEntityTypes.Italic,
  underline: ApiMessageEntityTypes.Underline,
  strike: ApiMessageEntityTypes.Strike,
  code: ApiMessageEntityTypes.Code,
  pre: ApiMessageEntityTypes.Pre,
  blockquote: ApiMessageEntityTypes.Blockquote,
  spoiler: ApiMessageEntityTypes.Spoiler,
  text_url: ApiMessageEntityTypes.TextUrl,
  mention: ApiMessageEntityTypes.Mention,
  custom_emoji: ApiMessageEntityTypes.CustomEmoji,
};

const API_TO_WIRE: Record<string, string> = Object.fromEntries(
  Object.entries(WIRE_TO_API).map(([wire, api]) => [api, wire]),
);

// P-44: text_url — только http(s)/mailto; `javascript:`/`tg:`/data: и прочие
// схемы из чужого сообщения не должны становиться кликабельными
const SAFE_URL_SCHEME = /^(https?:|mailto:)/i;
export function isSafeEntityUrl(url?: string) {
  if (!url) return false;
  const trimmed = url.trim();
  // eslint-disable-next-line no-control-regex
  return SAFE_URL_SCHEME.test(trimmed) && !/[\u0000-\u001f\s]/.test(trimmed);
}

// `textLength` — длина текста сообщения: offset/length из чужого сообщения
// обрезаются под него (иначе битые диапазоны ломали рендер).
export function wireEntitiesToApi(entities?: WireTextEntity[], textLength?: number): ApiMessageEntity[] | undefined {
  if (!entities?.length) return undefined;
  const result: ApiMessageEntity[] = [];
  entities.slice(0, 200).forEach((raw) => {
    const type = WIRE_TO_API[raw.type];
    if (!type) return;
    const offset = Math.max(0, Math.floor(Number(raw.offset) || 0));
    let length = Math.max(0, Math.floor(Number(raw.length) || 0));
    if (textLength !== undefined) {
      if (offset >= textLength) return;
      length = Math.min(length, textLength - offset);
    }
    if (!length) return;
    const e = { ...raw, offset, length };
    if (type === ApiMessageEntityTypes.TextUrl) {
      if (!isSafeEntityUrl(e.data)) return;
      result.push({ type, offset: e.offset, length: e.length, url: (e.data || '').trim() });
    } else if (type === ApiMessageEntityTypes.CustomEmoji) {
      result.push({
        type, offset: e.offset, length: e.length, documentId: e.data || '',
      });
    } else if (type === ApiMessageEntityTypes.Pre) {
      result.push({ type, offset: e.offset, length: e.length, language: e.data });
    } else {
      result.push({ type, offset: e.offset, length: e.length } as ApiMessageEntity);
    }
  });
  return result.length ? result : undefined;
}

export function apiEntitiesToWire(entities?: ApiMessageEntity[]): WireTextEntity[] | undefined {
  if (!entities?.length) return undefined;
  const result: WireTextEntity[] = [];
  entities.forEach((e) => {
    const wireType = API_TO_WIRE[e.type];
    if (!wireType) return;
    const wire: WireTextEntity = { type: wireType, offset: e.offset, length: e.length };
    if (e.type === ApiMessageEntityTypes.TextUrl) wire.data = e.url;
    if (e.type === ApiMessageEntityTypes.Pre && e.language) wire.data = e.language;
    if (e.type === ApiMessageEntityTypes.CustomEmoji) wire.data = e.documentId;
    result.push(wire);
  });
  return result.length ? result : undefined;
}
