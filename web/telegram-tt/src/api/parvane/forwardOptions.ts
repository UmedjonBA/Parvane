// Пересылка с параметрами меню Telegram (A3 ревью 7 ноя 2026): «Скрыть имя отправителя» — копия без заголовка
// «Переслано от» (`forwarded_*` не ставятся), «Скрыть подписи» — медиа без подписи, «Отправить без звука» —
// `silent` содержимого (A4). Текстовое сообщение подписи не имеет — его текст остаётся

import type { ApiMessage } from '../types';

export type ForwardOptions = {
  noAuthors?: boolean;
  noCaptions?: boolean;
  isSilent?: boolean;
};

type WireDraft = Record<string, unknown>;

// Виды, у которых `caption` — подпись к файлу (у текста и статьи текст — само сообщение)
const CAPTION_KINDS = new Set(['photo', 'video', 'video_note', 'voice', 'file', 'gif', 'sticker']);

export function hasMediaContent(content: ApiMessage['content']) {
  return Boolean(content.photo || content.video || content.document || content.audio || content.voice);
}

/** Подписи убираются, и имя автора тоже скрыто — как в Telegram (без подписей пересылка всегда «без автора»). */
export function isAuthorHidden(options: ForwardOptions) {
  return Boolean(options.noAuthors || options.noCaptions);
}

/**
 * Содержимое пересылки по параметрам: провод (`wire`, правится на месте) и локальная копия для ленты отправителя.
 * `author` — исходный автор (адрес и имя), его заголовок ставится, только если имя не скрыто.
 */
export function applyForwardOptions(
  wire: WireDraft,
  content: ApiMessage['content'],
  author: { address?: string; name?: string },
  options: ForwardOptions,
) {
  let nextContent = content;
  if (options.noCaptions && typeof wire.kind === 'string' && CAPTION_KINDS.has(wire.kind)) {
    delete wire.caption;
    delete wire.entities;
    if (hasMediaContent(content) && content.text) {
      const { text: _caption, ...rest } = content;
      nextContent = rest;
    }
  }
  const isHidden = isAuthorHidden(options);
  if (isHidden) {
    delete wire.forwarded_from;
    delete wire.forwarded_name;
  } else {
    wire.forwarded_from = author.address;
    wire.forwarded_name = author.name;
  }
  if (options.isSilent) wire.silent = true;
  else delete wire.silent;
  return { content: nextContent, hasForwardHeader: !isHidden };
}
