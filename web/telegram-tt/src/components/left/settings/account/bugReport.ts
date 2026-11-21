import { getActions, getGlobal } from '../../../../global';

import type { GlobalState } from '../../../../global/types';
import type { DiagEntry } from '../../../../util/parvaneDiag';
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

// «Журнал приложения · последний час» (доска `ZdProfileY`)
const LOG_WINDOW_MS = 60 * 60 * 1000;
const FRAME_WAIT_MS = 300;

export type BugReportInput = {
  description: string;
  steps: string;
  area: BugReportArea;
  withLog: boolean;
  scheme: string;
};

/** Первая строка того, что уйдёт: версия, система, схема — показ «Что будет отправлено». */
export function describeBugReportEnvironment(scheme: string) {
  return `Parvane ${APP_VERSION} · ${describePlatform()} · ${scheme}`;
}

/** Журнал действий за последний час (без текста сообщений и записей — его там нет и так). */
export function selectRecentDiag(entries: DiagEntry[], now: number) {
  return entries.filter((entry) => now - entry.t <= LOG_WINDOW_MS);
}

/** Отчёт целиком — то, что уйдёт вложением и что сохраняется в файл. */
export async function buildBugReport({
  description, steps, area, withLog, scheme,
}: BugReportInput) {
  const snapshot = buildStateSnapshot(getGlobal());
  const storeInfo = withLog ? await callParvane('fetchParvaneDiagStoreInfo', {
    chatId: 'chatId' in snapshot ? snapshot.chatId : undefined,
  }).catch(() => undefined) : undefined;
  const now = Date.now();
  return {
    version: APP_VERSION,
    environment: describeBugReportEnvironment(scheme),
    userAgent: navigator.userAgent,
    reportedAt: new Date(now).toISOString(),
    area,
    description,
    steps: steps || undefined,
    snapshot: withLog ? snapshot : undefined,
    storeInfo,
    log: withLog ? selectRecentDiag(getDiagEntries(), now) : undefined,
  };
}

export async function sendBugReport(input: BugReportInput & { screenshot?: Blob }): Promise<BugReportResult> {
  // Точное совпадение адреса: первый результат поиска выбирает сервер
  const targetChatId = await callParvane('parvaneResolveExactAddress', { address: PARVANE_BUG_REPORT_ADDRESS })
    .catch(() => undefined) as string | undefined;
  if (!targetChatId) return 'no-address';
  try {
    const report = await buildBugReport(input);
    const blob = new Blob([JSON.stringify(report, undefined, 1)], { type: 'application/json' });
    const attachments = [await buildAttachment(`parvane-bug-${Date.now()}.json`, blob)];
    if (input.screenshot) attachments.push(await buildAttachment(`parvane-bug-${Date.now()}.png`, input.screenshot));
    getActions().sendMessage({
      messageList: { chatId: targetChatId, threadId: MAIN_THREAD_ID, type: 'thread' },
      text: `🐞 [${input.area}] ${input.description}`,
      attachments,
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** «Сохранить в файл»: тот же отчёт JSON-файлом в загрузки браузера. */
export async function saveBugReport(input: BugReportInput) {
  const report = await buildBugReport(input);
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, undefined, 1)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `parvane-bug-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * «Снимок этого окна»: один кадр вкладки через выбор экрана браузера (`getDisplayMedia`, вкладка предлагается первой).
 * Без своей библиотеки отрисовать страницу в картинку нельзя; отказ либо нет поддержки — `undefined`.
 */
export async function captureWindow(): Promise<Blob | undefined> {
  if (!navigator.mediaDevices?.getDisplayMedia) return undefined;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => {
      setTimeout(resolve, FRAME_WAIT_MS);
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob || undefined), 'image/png');
    });
  } catch {
    return undefined;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
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
