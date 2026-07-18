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
};

const API_TO_WIRE: Record<string, string> = Object.fromEntries(
  Object.entries(WIRE_TO_API).map(([wire, api]) => [api, wire]),
);

export function wireEntitiesToApi(entities?: WireTextEntity[]): ApiMessageEntity[] | undefined {
  if (!entities?.length) return undefined;
  const result: ApiMessageEntity[] = [];
  entities.forEach((e) => {
    const type = WIRE_TO_API[e.type];
    if (!type) return;
    if (type === ApiMessageEntityTypes.TextUrl) {
      result.push({ type, offset: e.offset, length: e.length, url: e.data || '' });
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
    result.push(wire);
  });
  return result.length ? result : undefined;
}
