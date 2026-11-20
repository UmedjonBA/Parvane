import { getActions, getGlobal } from '../../../../global';

import type { GlobalState } from '../../../../global/types';
import { MAIN_THREAD_ID } from '../../../../api/types';

import {
  selectChatLastMessageId,
  selectChatMessages,
  selectCurrentMessageList,
  selectIsViewportNewest,
  selectListedIds,
  selectViewportIds,
} from '../../../../global/selectors';
import { selectThreadReadState } from '../../../../global/selectors/threads';
import { getDiagEntries, PARVANE_BUG_REPORT_ADDRESS } from '../../../../util/parvaneDiag';
import { callApi } from '../../../../api/gramjs';
import buildAttachment from '../../../middle/composer/helpers/buildAttachment';

// Parvane: отчёт об ошибке — описание, раздел и по желанию журнал действий клиента (`util/parvaneDiag`, без текста
// сообщений и записей) со снимком состояния текущей ленты уходят ОБЫЧНЫМ сообщением с вложением на
// `PARVANE_BUG_REPORT_ADDRESS` (E2E, через те же шарды; читает `scripts/bugs_reader.mjs`)

export const BUG_REPORT_AREAS = ['chats', 'planner', 'health', 'notes', 'files', 'music', 'other'] as const;
export type BugReportArea = typeof BUG_REPORT_AREAS[number];
export type BugReportResult = 'sent' | 'no-address' | 'failed';

const callParvane = callApi as unknown as (name: string, args: unknown) => Promise<unknown>;

/** Первая строка того, что уйдёт: версия, система, схема — показ «Что будет отправлено». */
export function describeBugReportEnvironment(scheme: string) {
  return `Parvane ${APP_VERSION} · ${describePlatform()} · ${scheme}`;
}

export async function sendBugReport({ description, area, withLog, scheme }: {
  description: string;
  area: BugReportArea;
  withLog: boolean;
  scheme: string;
}): Promise<BugReportResult> {
  // Точное совпадение адреса: первый результат поиска выбирает сервер
  const targetChatId = await callParvane('parvaneResolveExactAddress', { address: PARVANE_BUG_REPORT_ADDRESS })
    .catch(() => undefined) as string | undefined;
  if (!targetChatId) return 'no-address';
  try {
    const snapshot = buildStateSnapshot(getGlobal());
    const storeInfo = withLog ? await callParvane('fetchParvaneDiagStoreInfo', {
      chatId: 'chatId' in snapshot ? snapshot.chatId : undefined,
    }) : undefined;
    const report = {
      version: APP_VERSION,
      environment: describeBugReportEnvironment(scheme),
      userAgent: navigator.userAgent,
      reportedAt: new Date().toISOString(),
      area,
      description,
      snapshot: withLog ? snapshot : undefined,
      storeInfo,
      log: withLog ? getDiagEntries() : undefined,
    };
    const blob = new Blob([JSON.stringify(report, undefined, 1)], { type: 'application/json' });
    const attachment = await buildAttachment(`parvane-bug-${Date.now()}.json`, blob);
    getActions().sendMessage({
      messageList: { chatId: targetChatId, threadId: MAIN_THREAD_ID, type: 'thread' },
      text: `🐞 [${area}] ${description}`,
      attachments: [attachment],
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}

function describePlatform() {
  const agent = navigator.userAgent;
  if (/android/i.test(agent)) return 'Android';
  if (/iphone|ipad/i.test(agent)) return 'iOS';
  if (/windows/i.test(agent)) return 'Windows';
  if (/mac os/i.test(agent)) return 'macOS';
  if (/linux/i.test(agent)) return 'Linux';
  return 'Web';
}

function buildStateSnapshot(global: GlobalState) {
  const messageList = selectCurrentMessageList(global);
  if (!messageList) return { note: 'no current chat' };
  const { chatId, threadId } = messageList;
  const viewportIds = selectViewportIds(global, chatId, threadId);
  const listedIds = selectListedIds(global, chatId, threadId);
  return {
    chatId,
    threadId,
    type: messageList.type,
    lastMessageId: selectChatLastMessageId(global, chatId),
    isViewportNewest: selectIsViewportNewest(global, chatId, threadId),
    viewport: viewportIds ? {
      len: viewportIds.length, first: viewportIds[0], last: viewportIds[viewportIds.length - 1],
    } : undefined,
    listed: listedIds ? {
      len: listedIds.length, first: listedIds[0], last: listedIds[listedIds.length - 1],
    } : undefined,
    readState: selectThreadReadState(global, chatId, threadId),
    byIdCount: Object.keys(selectChatMessages(global, chatId) || {}).length,
  };
}
