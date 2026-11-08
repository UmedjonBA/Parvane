// Переход по ссылке заметки и статьи (C7-4, ревью 7 ноя 2026): как ссылки сообщений (`SafeLink`) — через действие
// `openUrl`, которое показывает окно с настоящим адресом (`SafeLinkModal`), когда подпись не совпадает с адресом
// или в домене смешаны письменности. Раньше — обычный `<a target="_blank">` без окна

import { isMixedScriptUrl } from '../../../util/browser/url';
import { linkNeedsConfirmation } from './markdown';

type OpenUrl = (payload: { url: string; shouldSkipModal?: boolean }) => void;
type LinkEvent = { preventDefault: () => void; button?: number; type?: string };

export function isTrustedMarkdownLink(text: string, url: string) {
  return !linkNeedsConfirmation(text, url) && !isMixedScriptUrl(url);
}

/** Клик (или средняя кнопка) по ссылке: переход — через `openUrl`; браузер сам ссылку не открывает. */
export function handleMarkdownLinkClick(e: LinkEvent, text: string, url: string, openUrl: OpenUrl) {
  if (e.type === 'auxclick' && e.button !== 1) return;
  e.preventDefault();
  openUrl({ url, shouldSkipModal: isTrustedMarkdownLink(text, url) });
}
