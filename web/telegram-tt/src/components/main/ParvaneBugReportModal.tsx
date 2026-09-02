import type { FC } from '../../lib/teact/teact';
import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';
import { getActions, getGlobal } from '../../global';

import type { GlobalState } from '../../global/types';
import { ApiMediaFormat, MAIN_THREAD_ID } from '../../api/types';

import { getDocumentMediaHash } from '../../global/helpers/messageMedia';
import {
  selectChatLastMessageId,
  selectChatMessage,
  selectChatMessages,
  selectCurrentMessageList,
  selectIsViewportNewest,
  selectListedIds,
  selectViewportIds,
} from '../../global/selectors';
import { selectThreadReadState } from '../../global/selectors/threads';
import * as mediaLoader from '../../util/mediaLoader';
import {
  BUG_REPORT_OPEN_EVENT, getDiagEntries, PARVANE_BUG_REPORT_ADDRESS,
} from '../../util/parvaneDiag';
import { callApi } from '../../api/gramjs';
import buildAttachment from '../middle/composer/helpers/buildAttachment';

import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Modal from '../ui/Modal';
import TextArea from '../ui/TextArea';

// Parvane (ВРЕМЕННО, на период отладки с живыми пользователями): модалка
// «Report a Bug» — описание + JSON-журнал действий клиента (util/parvaneDiag)
// + снимок состояния текущей ленты уходят ОБЫЧНЫМ сообщением с вложением
// на PARVANE_BUG_REPORT_ADDRESS (E2E, через те же шарды — серверных
// изменений не требует). Открывается событием BUG_REPORT_OPEN_EVENT из меню.

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

// Read-only хук для читалки отчётов (scripts/bugs_reader.mjs): отдать текст
// JSON-вложения по chatId/messageId через штатный mediaLoader (расшифровка
// blobcrypt внутри), минуя браузерное скачивание, которое в headless не ловится
// Хуки для пробников/e2e — ТОЛЬКО в сборках с VITE_PARVANE_DIAG_HOOKS=1: в
// проде они превращали бы любой XSS в полный доступ к провайдеру и ключам
const ARE_DIAG_HOOKS_ENABLED = import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1';
if (ARE_DIAG_HOOKS_ENABLED) {
  (window as unknown as { __parvaneDiagCallApi?: typeof callApi }).__parvaneDiagCallApi = callApi;
}

// Чтение JSON-вложения отчёта читалкой bugs_reader.mjs — read-only и только
// свои документы (их и так можно скачать со страницы), поэтому остаётся в проде
(window as unknown as {
  __parvaneDiagReadDocument?: (chatId: string, messageId: number) => Promise<string | undefined>;
}).__parvaneDiagReadDocument = async (chatId, messageId) => {
  const message = selectChatMessage(getGlobal(), chatId, messageId);
  const document = message?.content.document;
  if (!document) return undefined;
  const mediaHash = getDocumentMediaHash(document, 'download');
  if (!mediaHash) return undefined;
  const blobUrl = await mediaLoader.fetch(mediaHash, ApiMediaFormat.BlobUrl);
  if (typeof blobUrl !== 'string') return undefined;
  return (await fetch(blobUrl)).text();
};

const ParvaneBugReportModal: FC = () => {
  const { sendMessage, showNotification } = getActions();
  const [isOpen, setIsOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    window.addEventListener(BUG_REPORT_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(BUG_REPORT_OPEN_EVENT, handleOpen);
  }, []);

  const handleClose = useLastCallback(() => {
    if (isSending) return;
    setIsOpen(false);
  });

  const handleSend = useLastCallback(async () => {
    const text = description.trim();
    if (!text || isSending) return;
    setIsSending(true);
    try {
      // Точное совпадение адреса: первый результат поиска выбирает сервер
      const targetChatId = await (callApi as unknown as (name: string, args: unknown) => Promise<string | undefined>)(
        'parvaneResolveExactAddress', { address: PARVANE_BUG_REPORT_ADDRESS },
      );
      if (!targetChatId) {
        showNotification({ message: `Bug report address not found: ${PARVANE_BUG_REPORT_ADDRESS}` });
        return;
      }
      const global = getGlobal();
      const snapshot = buildStateSnapshot(global);
      // Метод — наш, его нет в типах gramjs-Methods, поэтому вызов через cast
      const storeInfo = await (callApi as unknown as (name: string, args: unknown) => Promise<unknown>)(
        'fetchParvaneDiagStoreInfo',
        { chatId: 'chatId' in snapshot ? snapshot.chatId : undefined },
      );
      const report = {
        version: APP_VERSION,
        userAgent: navigator.userAgent,
        reportedAt: new Date().toISOString(),
        description: text,
        snapshot,
        storeInfo,
        log: getDiagEntries(),
      };
      const blob = new Blob([JSON.stringify(report, undefined, 1)], { type: 'application/json' });
      const attachment = await buildAttachment(`parvane-bug-${Date.now()}.json`, blob);
      sendMessage({
        messageList: { chatId: targetChatId, threadId: MAIN_THREAD_ID, type: 'thread' },
        text: `🐞 ${text}`,
        attachments: [attachment],
      });
      showNotification({ message: 'Bug report sent. Thank you!' });
      setDescription('');
      setIsOpen(false);
    } catch (error) {
      showNotification({ message: `Bug report failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setIsSending(false);
    }
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Report a Bug"
      className="narrow"
    >
      <p>
        Describe what happened and what you did right before it. Your last actions in the app
        (without message contents) will be attached automatically.
      </p>
      <TextArea
        value={description}
        placeholder="What went wrong?"
        onChange={(e) => setDescription(e.currentTarget.value)}
        maxLength={2000}
      />
      <div className="dialog-buttons">
        <Button
          className="confirm-dialog-button"
          isText
          disabled={!description.trim() || isSending}
          onClick={handleSend}
        >
          {isSending ? 'Sending…' : 'Send'}
        </Button>
        <Button className="confirm-dialog-button" isText onClick={handleClose}>Cancel</Button>
      </div>
    </Modal>
  );
};

export default memo(ParvaneBugReportModal);
