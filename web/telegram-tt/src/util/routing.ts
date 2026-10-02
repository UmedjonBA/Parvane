import type { MessageListType, ThreadId } from '../types';
import { MAIN_THREAD_ID } from '../api/types';

import { IS_MOCKED_CLIENT } from '../config';

let parsedInitialLocationHash: Record<string, string> | undefined;
let messageHash: string | undefined;
let isAlreadyParsed = false;
let initialLocationHash = window.location.hash;

// Parvane: ссылка-приглашение в адресной строке `#+<токен>`. Вход в аккаунт
// может перезагрузить страницу — токен переживает её в sessionStorage и
// потребляется после синка (Main.tsx)
const PENDING_INVITE_KEY = 'parvane:pending-invite';
const INVITE_HASH_REGEX = /^#\+([0-9a-f]{32})$/;
// Ссылка-приглашение v2 (spec 007, T084): `https://<домен>/join/<link_id>#<секрет>`;
// секрет — во фрагменте, серверу не уходит. Вступление — по ссылке целиком
const V2_INVITE_PATH_REGEX = /^\/join\/([A-Za-z0-9_-]{43})$/;
const V2_INVITE_SECRET_REGEX = /^#[A-Za-z0-9_-]{43}$/;
const V2_INVITE_URL_REGEX = /^https:\/\/[^/\s]+\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/;

export function matchV2InviteUrl(url: string) {
  const trimmed = url.trim();
  return V2_INVITE_URL_REGEX.test(trimmed) ? trimmed : undefined;
}

export function rememberPendingInvite(hash: string) {
  const match = hash.match(INVITE_HASH_REGEX);
  if (!match) return;
  savePendingInvite(match[1]);
}

function savePendingInvite(invite: string) {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, invite);
  } catch {
    // приватный режим — вступление сработает только без перезагрузки
  }
}

// Ссылка v2 открыта в адресной строке (сервер отдаёт приложение и для /join/…):
// ссылка целиком ждёт синка, адрес приложения — обратно на корень
function rememberV2InviteFromLocation() {
  const { pathname, hash, host } = window.location;
  if (!V2_INVITE_PATH_REGEX.test(pathname) || !V2_INVITE_SECRET_REGEX.test(hash)) return;
  savePendingInvite(`https://${host}${pathname}${hash}`);
  initialLocationHash = '';
  window.history.replaceState(window.history.state, '', '/');
}

rememberV2InviteFromLocation();
rememberPendingInvite(initialLocationHash);

// Вставка `#+<токен>` в адрес уже открытой вкладки меняет только хэш —
// перезагрузки нет, ловим hashchange
export function matchInviteHash(hash: string) {
  return hash.match(INVITE_HASH_REGEX)?.[1];
}

// Токен, не тронув его: пока синк не прошёл, вступление невозможно, но и
// терять ссылку нельзя — повторное открытие/перезагрузка должны сработать
export function peekPendingInvite(): string | undefined {
  const fromHash = initialLocationHash.match(INVITE_HASH_REGEX)?.[1];
  if (fromHash) return fromHash;
  try {
    return sessionStorage.getItem(PENDING_INVITE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingInvite(): string | undefined {
  let token = initialLocationHash.match(INVITE_HASH_REGEX)?.[1];
  try {
    token = token || sessionStorage.getItem(PENDING_INVITE_KEY) || undefined;
    sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // нет sessionStorage — остаётся токен из текущего адреса
  }
  if (initialLocationHash.match(INVITE_HASH_REGEX)) initialLocationHash = '';
  return token;
}

export function resetInitialLocationHash() {
  isAlreadyParsed = false;
  messageHash = undefined;
  parsedInitialLocationHash = undefined;
  initialLocationHash = '';
}

export function resetLocationHash() {
  window.location.hash = '';
}

export const createLocationHash = (chatId: string, type: MessageListType, threadId: ThreadId): string => {
  const displayType = type === 'thread' ? undefined : type;
  const parts = threadId === MAIN_THREAD_ID ? [chatId, displayType] : [chatId, threadId, displayType];

  return parts.filter(Boolean).join('_');
};

export function parseLocationHash(currentUserId?: string) {
  parseInitialLocationHash();

  if (!messageHash) return undefined;

  const parts = messageHash.split('_');
  let chatId: string | undefined;
  let type: string | undefined;
  let threadId: string | undefined;
  if (parts.length === 1) {
    chatId = parts[0];
  } else if (parts.length === 2) {
    const isType = ['thread', 'pinned', 'scheduled'].includes(parts[1]);
    chatId = parts[0];
    type = isType ? parts[1] : 'thread';
    threadId = !isType ? parts[1] : undefined;
  } else if (parts.length >= 3) {
    [chatId, threadId, type] = parts;
  }
  if (!chatId?.match(/^-?\d+$/)) return undefined;

  const isType = ['thread', 'pinned', 'scheduled'].includes(type!);

  const castedThreadId = (chatId === currentUserId ? threadId : Number(threadId)) || MAIN_THREAD_ID;

  return {
    chatId,
    type: type && isType ? (type as MessageListType) : 'thread',
    threadId: castedThreadId,
  };
}

export const createMessageHashUrl = (chatId: string, type: MessageListType, threadId: ThreadId): string => {
  const url = new URL(window.location.href);
  url.hash = createLocationHash(chatId, type, threadId);
  return url.href;
};

export function parseInitialLocationHash() {
  if (parsedInitialLocationHash) return parsedInitialLocationHash;

  if (isAlreadyParsed) return undefined;

  const locationHash = getInitialLocationHash();
  if (!locationHash) return undefined;

  let parsedHash = locationHash.replace(/^#/, '');
  if (parsedHash.includes('?')) {
    [messageHash, parsedHash] = parsedHash.split('?');
    if (!IS_MOCKED_CLIENT) {
      window.location.hash = messageHash;
    }
  } else if (parsedHash.includes('=')) {
    if (!IS_MOCKED_CLIENT) {
      window.location.hash = '';
    }
  }

  parsedInitialLocationHash = parsedHash.includes('=') ? parsedHash.split('&').reduce((acc, cur) => {
    const [key, value] = cur.split('=');
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>) : undefined;
  isAlreadyParsed = true;
  if (!parsedInitialLocationHash) {
    messageHash = parsedHash;
  }

  return parsedInitialLocationHash;
}

export function clearWebTokenAuth() {
  if (!parsedInitialLocationHash) return;

  delete parsedInitialLocationHash.tgWebAuthToken;
}

export function getInitialLocationHash() {
  return initialLocationHash;
}
