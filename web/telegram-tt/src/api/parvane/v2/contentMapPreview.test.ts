import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { initSync } from '../../../lib/parvane-protocol/parvane_protocol';
import { contentOfWire, wireOfContent } from './contentMap';

// Виды содержимого разбирает движок (spec 035 T114) — WASM нужен и юнит-тестам
beforeAll(() => {
  initSync({ module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')) });
});

// WEB-13: карточку превью ссылки собирает отправитель — адрес не http(s) не превращается в карточку
describe('превью ссылки во входящем', () => {
  const withPreview = (url: string) => wireOfContent({
    text: { text: 'смотри', preview: { url, title: 'Заголовок' } },
  });

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
    kind: 'photo', file_id: 'f1', mime: 'image/jpeg', width: 960, height: 540, file_key: 'aw==', file_nonce: 'bg==',
    capability: 'Yw==',
  };

  it('уходит вложением LinkPreview.image и возвращается фото', () => {
    const v2 = contentOfWire({ kind: 'text', text: 'смотри', webpage: { url: 'https://example.org', photo } });
    expect(v2.text?.preview?.image?.kind).toBe('MEDIA_KIND_PHOTO');
    expect(v2.text?.preview?.image?.capability).toBe('Yw==');
    const back = wireOfContent(v2);
    expect(back?.webpage?.photo).toMatchObject({ kind: 'photo', file_id: 'f1', width: 960, capability: 'Yw==' });
  });

  it('без ключей или не фото — карточка без картинки', () => {
    const noKey = wireOfContent({
      text: { text: 'x', preview: { url: 'https://example.org', image: { kind: 'MEDIA_KIND_PHOTO', file_id: 'f' } } },
    });
    expect(noKey?.webpage?.url).toBe('https://example.org');
    expect(noKey?.webpage?.photo).toBeUndefined();
    const video = wireOfContent({
      text: {
        text: 'x',
        preview: {
          url: 'https://example.org',
          image: {
            kind: 'MEDIA_KIND_VIDEO', file_id: 'f', file_key: 'aw==', file_nonce: 'bg==',
          },
        },
      },
    });
    expect(video?.webpage?.photo).toBeUndefined();
  });
});

describe('статья во входящем', () => {
  it('длина статьи ограничена при приёме', () => {
    const wire = wireOfContent({ article: { title: 't', markdown: 'x'.repeat(200000) } });
    expect((wire as { markdown: string }).markdown.length).toBe(65536);
  });
});
