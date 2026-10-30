import { describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '../../api/types';

import { renderMessageSummaryHtml } from './renderMessageSummaryHtml';

vi.mock('../../components/common/helpers/renderMessageText', () => ({
  renderMessageText: () => ['<b>hello</b>'],
}));
vi.mock('..', () => ({ getGlobal: () => ({}) }));
vi.mock('./messages', () => ({ getMessageStatefulContent: () => undefined }));
// Описание, как в messageSummary: расширенное описание документа — имя файла как есть, у текста — переданный HTML
vi.mock('./messageSummary', () => ({
  getMessageSummaryEmoji: () => '',
  getMessageSummaryDescription: (
    _lang: unknown, message: ApiMessage, _stateful: unknown, text: string,
  ) => (message.content.document ? `${message.content.document.fileName}\n${text}` : text),
}));

const lang = ((key: string) => key) as never;

describe('renderMessageSummaryHtml', () => {
  it('escapes a hostile document file name but keeps the rendered message text', () => {
    const message = {
      id: 1,
      chatId: '1',
      content: {
        document: { fileName: '<a href="https://phish.example">Bank</a>' },
      },
    } as unknown as ApiMessage;
    const html = renderMessageSummaryHtml(lang, message);
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;a');
    expect(html).toContain('<b>hello</b>');
  });
});
