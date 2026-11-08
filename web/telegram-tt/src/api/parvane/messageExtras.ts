// MEDIA-2 и QUOTE-1 (этап 4 ревью 7 ноя 2026): спойлер медиа, подпись над медиа, альбомы и цитата в ответе.
// Отправка: параметры tt (`shouldSendAsSpoiler`, `isInvertedMedia`, `groupedId`, `replyInfo.quoteText`) → поля
// содержимого провода; приём: поля провода → `ApiMessage` (`isSpoiler`, `isInvertedMedia`, `groupedId`/`isInAlbum`,
// `replyInfo.quoteText`). Логика — здесь, чтобы её проверял vitest; провайдер только зовёт.

import type {
  ApiFormattedText, ApiMessage, ApiMessageReplyInfo, ApiReplyInfo,
} from '../types';
import type { WireMessageContent, WireReplyQuote } from './wire';

import { bytesToBase64 } from './v2/base64';
import { apiEntitiesToWire, wireEntitiesToApi } from './entities';

/** Предел альбома Telegram (и правила MEDIA-2). */
export const ALBUM_MAX_ITEMS = 10;

const ALBUM_ID_BYTES = 16;

/** tt-шный `groupedId` альбома → случайный `Media.album_id` (одно значение на альбом). */
export function createAlbumIds(random: (n: number) => Uint8Array = randomBytes) {
  const byGroupedId = new Map<string, string>();
  return (groupedId: string) => {
    let id = byGroupedId.get(groupedId);
    if (!id) {
      id = bytesToBase64(random(ALBUM_ID_BYTES));
      byGroupedId.set(groupedId, id);
      if (byGroupedId.size > 200) byGroupedId.delete(byGroupedId.keys().next().value!);
    }
    return id;
  };
}

function randomBytes(n: number) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Элементы альбома уходят ПОДРЯД (MEDIA-2): загрузки идут параллельно, а отправка каждого элемента ждёт отправки
 * предыдущего того же альбома. `enter` зовётся синхронно в порядке элементов.
 */
export function createAlbumSendQueue() {
  const tailByGroup = new Map<string, Promise<void>>();
  return {
    enter(groupedId: string) {
      const previous = tailByGroup.get(groupedId) || Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => mine);
      tailByGroup.set(groupedId, tail);
      return {
        ready: previous,
        done() {
          release();
          void tail.then(() => {
            if (tailByGroup.get(groupedId) === tail) tailByGroup.delete(groupedId);
          });
        },
      };
    },
  };
}

/** Цитата ответа из `replyInfo` tt → `Content.reply_quote` (только при ответе). */
export function quoteFromReplyInfo(replyInfo: ApiReplyInfo | undefined): WireReplyQuote | undefined {
  if (replyInfo?.type !== 'message' || !replyInfo.replyToMsgId) return undefined;
  const quote = (replyInfo as { quoteText?: ApiFormattedText }).quoteText;
  if (!quote?.text) return undefined;
  const offset = (replyInfo as { quoteOffset?: number }).quoteOffset;
  return {
    text: quote.text,
    entities: apiEntitiesToWire(quote.entities),
    offset: offset && offset > 0 ? offset : undefined,
  };
}

/** Поля провода, которые несут опции окна отправки (спойлер, подпись над медиа, альбом, цитата). */
export function sendExtras(params: {
  attachment?: { shouldSendAsSpoiler?: boolean; shouldSendAsFile?: boolean };
  isInvertedMedia?: boolean;
  groupedId?: string;
  replyInfo?: ApiReplyInfo;
  text?: string;
}, albumIdOf: (groupedId: string) => string): Partial<WireMessageContent> {
  const out: Partial<WireMessageContent> = {};
  if (params.attachment?.shouldSendAsSpoiler) out.spoiler = true;
  // Как у Telegram: подпись над медиа — только когда подпись есть (или текст с карточкой ссылки)
  if (params.isInvertedMedia && params.text) out.invert_media = true;
  if (params.groupedId) out.album_id = albumIdOf(params.groupedId);
  const quote = quoteFromReplyInfo(params.replyInfo);
  if (quote) out.reply_quote = quote;
  return out;
}

/** Спойлер на фото/видео/GIF содержимого tt. */
export function withMediaSpoiler(
  content: ApiMessage['content'], isSpoiler: boolean | undefined,
): ApiMessage['content'] {
  if (!isSpoiler) return content;
  if (content.photo) return { ...content, photo: { ...content.photo, isSpoiler: true } };
  if (content.video && !content.video.isRound) return { ...content, video: { ...content.video, isSpoiler: true } };
  return content;
}

/** `replyInfo` принятого сообщения с цитатой QUOTE-1. */
export function replyInfoWithQuote(
  replyToMsgId: number, quote: WireReplyQuote | undefined,
): ApiMessageReplyInfo {
  if (!quote?.text) return { type: 'message', replyToMsgId };
  return {
    type: 'message',
    replyToMsgId,
    isQuote: true,
    quoteText: { text: quote.text, entities: wireEntitiesToApi(quote.entities, quote.text.length) },
    quoteOffset: quote.offset,
  };
}

/**
 * Группировка альбомов у получателя (MEDIA-2): сообщения одного автора в одном чате с одним `album_id` получают общий
 * `groupedId`, не больше {@link ALBUM_MAX_ITEMS} в группе (по порядку id в ленте). «Подряд» обеспечивает сама лента
 * tt: альбом обрывается на первом сообщении с другим `groupedId`.
 */
export function createAlbumIndex() {
  const idsByKey = new Map<string, number[]>();
  return {
    groupedId(chatId: string, from: string, albumId: string, messageId: number) {
      const key = `${chatId}|${from}|${albumId}`;
      let ids = idsByKey.get(key);
      if (!ids) {
        ids = [];
        idsByKey.set(key, ids);
      }
      let rank = ids.indexOf(messageId);
      if (rank < 0) {
        let low = 0;
        let high = ids.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (ids[mid] < messageId) low = mid + 1;
          else high = mid;
        }
        ids.splice(low, 0, messageId);
        rank = low;
      }
      return `a:${chatId}:${from}:${albumId}:${Math.floor(rank / ALBUM_MAX_ITEMS)}`;
    },
    clear() {
      idsByKey.clear();
    },
  };
}

/** Альбомные поля `ApiMessage` (как `buildApiMessage` gramjs: документы — группа документов без `isInAlbum`). */
export function albumFields(content: ApiMessage['content'], groupedId: string | undefined) {
  if (!groupedId) return {};
  const isInAlbum = Boolean(content.photo || (content.video && !content.video.isRound && !content.video.isGif));
  return isInAlbum ? { groupedId, isInAlbum: true as const } : { groupedId };
}
