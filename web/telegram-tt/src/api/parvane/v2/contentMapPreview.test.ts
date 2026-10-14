import { describe, expect, it } from 'vitest';

import { v2ToWire } from './contentMap';

// WEB-13: карточку превью ссылки собирает отправитель — адрес не http(s) не превращается в карточку
describe('превью ссылки во входящем', () => {
  const withPreview = (url: string) => v2ToWire({ text: { text: 'смотри', preview: { url, title: 'Заголовок' } } });

  it('http(s) — карточка', () => {
    expect(withPreview('https://example.org/a')?.webpage?.url).toBe('https://example.org/a');
    expect(withPreview('http://example.org')?.webpage?.title).toBe('Заголовок');
  });

  it('javascript:, data:, file: и мусор — без карточки, текст остаётся', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'не адрес']) {
      const content = withPreview(url);
      expect(content?.webpage, url).toBeUndefined();
      expect(content?.text).toBe('смотри');
    }
  });
});
