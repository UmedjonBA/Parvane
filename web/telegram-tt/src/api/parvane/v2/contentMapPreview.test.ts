import { describe, expect, it } from 'vitest';

import { v2ToWire, wireToV2 } from './contentMap';

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

describe('картинка превью ссылки', () => {
  const photo = {
    kind: 'photo', file_id: 'f1', mime: 'image/jpeg', width: 960, height: 540, file_key: 'k', file_nonce: 'n',
    capability: 'c',
  };

  it('уходит вложением LinkPreview.image и возвращается фото', () => {
    const v2 = wireToV2({ kind: 'text', text: 'смотри', webpage: { url: 'https://example.org', photo } });
    expect(v2.text?.preview?.image?.kind).toBe('MEDIA_KIND_PHOTO');
    expect(v2.text?.preview?.image?.capability).toBe('c');
    const back = v2ToWire(v2);
    expect(back?.webpage?.photo).toMatchObject({ kind: 'photo', file_id: 'f1', width: 960, capability: 'c' });
  });

  it('без ключей или не фото — карточка без картинки', () => {
    const noKey = v2ToWire({
      text: { text: 'x', preview: { url: 'https://example.org', image: { kind: 'MEDIA_KIND_PHOTO', file_id: 'f' } } },
    });
    expect(noKey?.webpage?.url).toBe('https://example.org');
    expect(noKey?.webpage?.photo).toBeUndefined();
    const video = v2ToWire({
      text: {
        text: 'x',
        preview: {
          url: 'https://example.org', image: { kind: 'MEDIA_KIND_VIDEO', file_id: 'f', file_key: 'k', file_nonce: 'n' },
        },
      },
    });
    expect(video?.webpage?.photo).toBeUndefined();
  });
});
