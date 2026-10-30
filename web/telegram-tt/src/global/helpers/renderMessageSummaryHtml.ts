import type { ApiMessage } from '../../api/types';

import { type LangFn } from '../../util/localization';
import { renderMessageText } from '../../components/common/helpers/renderMessageText';
import { escapeHtml } from '../../components/middle/composer/helpers/cleanHtml';
import { getGlobal } from '..';
import { getMessageStatefulContent } from './messages';
import { getMessageSummaryDescription, getMessageSummaryEmoji } from './messageSummary';

const TEXT_PLACEHOLDER = '\uE000text\uE000';

export function renderMessageSummaryHtml(
  lang: LangFn,
  message: ApiMessage,
) {
  const global = getGlobal();
  const emoji = getMessageSummaryEmoji(message);
  const emojiWithSpace = emoji ? `${emoji} ` : '';
  const text = (renderMessageText({ message, shouldRenderAsHtml: true }) as string[])?.join('');

  const statefulContent = getMessageStatefulContent(global, message);

  // Описание (имя файла, название статьи/задания, автор аудио) задаёт собеседник: экранируем всё,
  // кроме уже отрисованного HTML текста сообщения, который подставляется вместо метки
  const description = getMessageSummaryDescription(
    lang, message, statefulContent, text ? TEXT_PLACEHOLDER : text, true,
  );
  const escaped = escapeHtml(typeof description === 'string' ? description : String(description as unknown));

  return `${emojiWithSpace}${escaped.split(TEXT_PLACEHOLDER).join(text)}`;
}
