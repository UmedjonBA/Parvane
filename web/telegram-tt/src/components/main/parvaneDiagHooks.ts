import { getGlobal } from '../../global';

import { ApiMediaFormat } from '../../api/types';

import { getDocumentMediaHash } from '../../global/helpers/messageMedia';
import { selectChatMessage } from '../../global/selectors';
import * as mediaLoader from '../../util/mediaLoader';
import { callApi } from '../../api/gramjs';

// Parvane: хуки для читалки отчётов об ошибках и сценариев (прежде жили в окне «Report a Bug»; окно стало экраном
// «Профиль → Сообщить об ошибке», хуки нужны с запуска приложения).
// Хуки для пробников/e2e — ТОЛЬКО в сборках с VITE_PARVANE_DIAG_HOOKS=1: в проде они превращали бы любой XSS в полный
// доступ к провайдеру и ключам
const ARE_DIAG_HOOKS_ENABLED = import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1';
if (ARE_DIAG_HOOKS_ENABLED) {
  (window as unknown as { __parvaneDiagCallApi?: typeof callApi }).__parvaneDiagCallApi = callApi;
}

// Чтение JSON-вложения отчёта читалкой bugs_reader.mjs через штатный mediaLoader (расшифровка внутри), минуя
// браузерное скачивание, которое в headless не ловится. Read-only и только свои документы (их и так можно скачать
// со страницы), поэтому остаётся в проде
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
