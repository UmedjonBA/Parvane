// Ссылки, почта, @ники и #хештеги в тексте сообщения. В Telegram эти entities
// размечает сервер; у нас сервер видит только шифртекст, поэтому разметка
// строится на клиенте при сборке сообщения для UI — одинаково у отправителя
// (локальное эхо, правка) и у получателя (стор, история). На провод `Url`,
// `Email` и `Hashtag` не уходят (`apiEntitiesToWire` их не знает).
//
// Безопасность (P-44): ссылкой становится только http(s) либо голый домен из
// списка зон (откроется как https://); `javascript:`, `data:` и прочие схемы
// не распознаются вовсе.

import type { ApiMessageEntity } from '../types';
import { ApiMessageEntityTypes } from '../types';

import { isSafeEntityUrl } from './entities';

const MAX_TEXT_LENGTH = 16384;
const MAX_AUTO_ENTITIES = 100;

// Зоны голых доменов (`example.com`): без списка любое «файл.txt» или «т.е.»
// становилось бы ссылкой. Ссылки со схемой распознаются при любой зоне
const BARE_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'dev', 'app', 'ai', 'tv', 'cc', 'gg', 'fm', 'ly', 'to',
  'sh', 'im', 'gl', 'xyz', 'site', 'online', 'store', 'tech', 'pro', 'link', 'page', 'blog', 'news', 'cloud', 'edu',
  'gov', 'mil', 'int', 'wiki', 'live', 'club', 'space', 'top', 'shop', 'onion',
  'ru', 'su', 'рф', 'ua', 'by', 'kz', 'uz', 'tj', 'kg', 'am', 'az', 'ge', 'md', 'ee', 'lv', 'lt',
  'de', 'uk', 'fr', 'it', 'es', 'pt', 'nl', 'be', 'pl', 'cz', 'sk', 'ch', 'at', 'se', 'no', 'fi', 'dk', 'is', 'ie',
  'eu', 'us', 'ca', 'mx', 'br', 'ar', 'au', 'nz', 'jp', 'cn', 'kr', 'in', 'il', 'tr', 'ir', 'ae', 'sg', 'hk', 'tw',
]);

// Символ, после которого начинается слово (а не середина другого токена)
const WORD_CHAR = /[\p{L}\p{N}_]/u;

const SCHEME_URL = /https?:\/\/[^\s<>"'«»`]+/giu;
const BARE_DOMAIN = new RegExp(
  '(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?\\.)+([\\p{L}]{2,24})'
  + '(?::\\d{1,5})?(?:[/?#][^\\s<>"\'«»`]*)?',
  'gu',
);
const EMAIL = /[\p{L}\p{N}._+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,24}/gu;
// Ник Parvane (`valid_nick` identity: латиница, цифры, `_ . -`, первая — буква
// или цифра, 2–64), необязательно с доменом сервера: `@alice@example.org`.
// Регистр в тексте любой (мобильная клавиатура ставит заглавную)
const MENTION = /@([A-Za-z0-9][A-Za-z0-9_.-]{1,63})(?:@((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,24}))?/gu;
const HASHTAG = /#([\p{L}\p{N}_]{1,64})/gu;

// Типы, внутри которых автоматическая разметка не делается: ссылки, код,
// упоминания и кастом-эмодзи уже размечены; форматирование (жирный, курсив…)
// может содержать ссылку целиком
const BLOCKING_TYPES = new Set<string>([
  ApiMessageEntityTypes.Code,
  ApiMessageEntityTypes.Pre,
  ApiMessageEntityTypes.TextUrl,
  ApiMessageEntityTypes.Url,
  ApiMessageEntityTypes.Email,
  ApiMessageEntityTypes.Mention,
  ApiMessageEntityTypes.MentionName,
  ApiMessageEntityTypes.Hashtag,
  ApiMessageEntityTypes.Cashtag,
  ApiMessageEntityTypes.BotCommand,
  ApiMessageEntityTypes.Phone,
  ApiMessageEntityTypes.CustomEmoji,
  ApiMessageEntityTypes.Timestamp,
  ApiMessageEntityTypes.FormattedDate,
]);

type Range = { offset: number; length: number };

function overlaps(a: Range, b: Range) {
  return a.offset < b.offset + b.length && b.offset < a.offset + a.length;
}

function contains(outer: Range, inner: Range) {
  return outer.offset <= inner.offset && inner.offset + inner.length <= outer.offset + outer.length;
}

function isWordChar(char: string | undefined) {
  return Boolean(char && WORD_CHAR.test(char));
}

/** Хвостовая пунктуация не входит в ссылку: «см. https://a.com/x.», «(https://a.com)». */
function trimUrlTail(url: string) {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if ('.,;:!?\'"»…'.includes(char)) {
      end--;
      continue;
    }
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const open = pairs[char];
    if (open) {
      const body = url.slice(0, end);
      const opened = body.split(open).length - 1;
      const closed = body.split(char).length - 1;
      if (closed > opened) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

function hostOf(url: string) {
  return url.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0];
}

export function detectAutoEntities(text: string): ApiMessageEntity[] {
  if (!text || text.length > MAX_TEXT_LENGTH) return [];
  const found: ApiMessageEntity[] = [];
  const isFree = (range: Range) => !found.some((entity) => overlaps(entity, range));
  const push = (type: ApiMessageEntityTypes, offset: number, length: number) => {
    if (found.length >= MAX_AUTO_ENTITIES || length <= 0) return;
    const range = { offset, length };
    if (!isFree(range)) return;
    found.push({ type, offset, length } as ApiMessageEntity);
  };

  // Порядок важен: почта раньше голого домена (иначе `bob@a.com` дал бы
  // ссылку на `a.com`), ссылка со схемой раньше голого домена
  for (const match of text.matchAll(EMAIL)) {
    const offset = match.index;
    const before = text[offset - 1];
    // `@alice@example.org` — упоминание с адресом, не почта
    if (before === '@' || isWordChar(before)) continue;
    const value = match[0].replace(/^[._+-]+/, '');
    const shift = match[0].length - value.length;
    if (!value.split('@')[0]) continue;
    push(ApiMessageEntityTypes.Email, offset + shift, value.length);
  }

  for (const match of text.matchAll(SCHEME_URL)) {
    const offset = match.index;
    if (isWordChar(text[offset - 1])) continue;
    const value = trimUrlTail(match[0]);
    if (!hostOf(value) || !isSafeEntityUrl(value)) continue;
    push(ApiMessageEntityTypes.Url, offset, value.length);
  }

  for (const match of text.matchAll(BARE_DOMAIN)) {
    const offset = match.index;
    const before = text[offset - 1];
    if (isWordChar(before) || (before && '@./:-#'.includes(before))) continue;
    if (!BARE_TLDS.has(match[1].toLowerCase())) continue;
    const value = trimUrlTail(match[0]);
    // Зона после обрезки хвоста должна остаться той же (`a.com.` → `a.com`)
    const host = hostOf(value);
    const tld = host.split('.').pop()?.toLowerCase();
    if (!tld || !BARE_TLDS.has(tld) || !isSafeEntityUrl(`https://${value}`)) continue;
    push(ApiMessageEntityTypes.Url, offset, value.length);
  }

  for (const match of text.matchAll(MENTION)) {
    const offset = match.index;
    const before = text[offset - 1];
    if (isWordChar(before) || (before && '@./#'.includes(before))) continue;
    // Точка/дефис в конце — пунктуация предложения, не ник: «пиши @alice.»
    const value = match[0].replace(/[.-]+$/, '');
    const nick = value.slice(1).split('@')[0];
    if (nick.length < 2) continue;
    push(ApiMessageEntityTypes.Mention, offset, value.length);
  }

  for (const match of text.matchAll(HASHTAG)) {
    const offset = match.index;
    const before = text[offset - 1];
    if (isWordChar(before) || (before && '&/#'.includes(before))) continue;
    // `#1`, `#2024` — номер, не хештег
    if (!/[\p{L}_]/u.test(match[1])) continue;
    push(ApiMessageEntityTypes.Hashtag, offset, match[0].length);
  }

  return found;
}

function sortEntities(entities: ApiMessageEntity[]) {
  return entities.slice().sort((a, b) => a.offset - b.offset || b.length - a.length);
}

/**
 * Добавляет к entities сообщения автоматическую разметку для участков, не
 * занятых ссылками/кодом/упоминаниями. Форматирование, целиком содержащее
 * найденный участок или целиком лежащее внутри него, не мешает; частичное
 * пересечение — мешает (рендер вложенности такого не любит).
 */
export function withAutoEntities(text: string | undefined, entities?: ApiMessageEntity[]) {
  if (!text) return entities;
  const auto = detectAutoEntities(text).filter((candidate) => !(entities || []).some((existing) => {
    if (!overlaps(existing, candidate)) return false;
    if (BLOCKING_TYPES.has(existing.type)) return true;
    return !contains(existing, candidate) && !contains(candidate, existing);
  }));
  if (!auto.length) return entities;
  return sortEntities([...(entities || []), ...auto]);
}
