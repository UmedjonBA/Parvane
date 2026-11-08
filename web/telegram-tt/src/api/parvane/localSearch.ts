// Поиск по локальной истории (история сообщений хранится на устройстве): вкладки глобального поиска по типу
// (A7 ревью 7 ноя 2026) и «Перейти к дате» (A5) — замены серверных `messages.search` и `messages.getHistory`
// с `offset_date` Telegram

import type { ApiMessage } from '../types';
import { ApiMessageEntityTypes } from '../types';

export function matchesMediaType(message: ApiMessage, type: string): boolean {
  const c = message.content;
  switch (type) {
    case 'media': return Boolean(c.photo || (c.video && !c.video.isRound && !c.video.isGif));
    case 'documents': return Boolean(c.document);
    case 'links': return Boolean(c.webPage || (c.text?.text && (
      /https?:\/\//.test(c.text.text) || c.text.entities?.some(
        (e) => e.type === ApiMessageEntityTypes.Url || e.type === ApiMessageEntityTypes.TextUrl,
      ))));
    case 'voice': return Boolean(c.voice || (c.video && c.video.isRound));
    case 'audio': return Boolean(c.audio);
    case 'gif': return Boolean(c.video?.isGif);
    default: return false;
  }
}

/** Строки, по которым находится сообщение: текст или подпись, имя файла, название и исполнитель трека. */
function searchableTexts(message: ApiMessage): string[] {
  const c = message.content;
  const out = [c.text?.text, c.document?.fileName, c.video?.fileName, c.audio?.fileName, c.audio?.title,
    c.audio?.performer];
  c.text?.entities?.forEach((e) => {
    if (e.type === ApiMessageEntityTypes.TextUrl) out.push(e.url);
  });
  return out.filter((value): value is string => Boolean(value));
}

export function matchesQuery(message: ApiMessage, needle: string) {
  return searchableTexts(message).some((text) => text.toLowerCase().includes(needle));
}

/** Отбор поиска (этап 4 ревью 7 ноя 2026: B1 дата, B2 тип чата, B3 автор). */
export type SearchFilters = {
  // Дата (сек): `minDate` включительно, `maxDate` — исключая (сутки из подсказки даты)
  minDate?: number;
  maxDate?: number;
  // «От пользователя» в поиске по группе: id отправителя
  fromId?: string;
  // «Сообщения из: личные / группы / каналы» глобального поиска
  context?: 'all' | 'users' | 'groups' | 'channels';
  chatKindOf?: (chatId: string) => 'users' | 'groups' | 'channels';
};

/**
 * Глобальный поиск по истории всех чатов. Вкладка типа без запроса — последние сообщения этого типа со всех чатов
 * (как в Telegram); с запросом — совпадение с подписью, именем файла, названием. Вкладка «Сообщения» без запроса —
 * пусто, если не задан отбор по дате или автору (тогда — все сообщения дня / автора). Новые — первыми.
 */
export function searchMessages(
  messages: ApiMessage[], query: string | undefined, type?: string, filters: SearchFilters = {},
) {
  const needle = query?.trim().toLowerCase() || '';
  const byType = type && type !== 'text';
  const {
    minDate, maxDate, fromId, context, chatKindOf,
  } = filters;
  const hasFilter = Boolean(minDate || maxDate || fromId);
  if (!byType && !needle && !hasFilter) return [];
  const byContext = context && context !== 'all' && chatKindOf ? context : undefined;
  return messages
    .filter((m) => (!byType || matchesMediaType(m, type))
      && (!needle || matchesQuery(m, needle))
      && (!minDate || m.date >= minDate)
      && (!maxDate || m.date < maxDate)
      && (!fromId || m.senderId === fromId)
      && (!byContext || chatKindOf!(m.chatId) === byContext)
      && !isEmptyResult(m, needle, byType))
    .sort((a, b) => b.date - a.date);
}

// Без запроса и типа (только отбор по дате/автору) служебные сообщения в выдачу не идут
function isEmptyResult(message: ApiMessage, needle: string, byType: unknown) {
  return !needle && !byType && Boolean(message.content.action);
}

/**
 * «Перейти к дате»: первое сообщение не раньше `timestamp` (сек); дата позже всей истории — последнее сообщение.
 * `messages` — история чата по возрастанию id.
 */
export function findFirstMessageIdAfterDate(messages: ApiMessage[], timestamp: number) {
  const visible = messages.filter((m) => !m.isScheduled);
  let best: ApiMessage | undefined;
  visible.forEach((m) => {
    if (m.date >= timestamp && (!best || m.date < best.date || (m.date === best.date && m.id < best.id))) best = m;
  });
  return (best || visible[visible.length - 1])?.id;
}
