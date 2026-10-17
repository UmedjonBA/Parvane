import { describe, expect, it } from 'vitest';

import type { ApiMessageEntity } from '../types';
import { ApiMessageEntityTypes } from '../types';

import { detectAutoEntities, withAutoEntities } from './autoEntities';

function spans(text: string, entities?: ApiMessageEntity[]) {
  return (entities || []).map((e) => [e.type, text.slice(e.offset, e.offset + e.length)]);
}

describe('detectAutoEntities: ссылки', () => {
  it('ссылка со схемой и голый домен', () => {
    const text = 'see https://example.org/a?b=1 and docs.example.com/x';
    expect(spans(text, detectAutoEntities(text))).toEqual([
      [ApiMessageEntityTypes.Url, 'https://example.org/a?b=1'],
      [ApiMessageEntityTypes.Url, 'docs.example.com/x'],
    ]);
  });

  it('хвостовая пунктуация и скобки не входят в ссылку', () => {
    const text = 'ссылка (https://example.org/page). И ещё http://test.dev/wiki_(x)!';
    expect(spans(text, detectAutoEntities(text))).toEqual([
      [ApiMessageEntityTypes.Url, 'https://example.org/page'],
      [ApiMessageEntityTypes.Url, 'http://test.dev/wiki_(x)'],
    ]);
  });

  it('javascript:, data: и прочие схемы ссылкой не становятся', () => {
    const text = 'javascript:alert(1) data:text/html,<b>x</b> ftp://example.org tg://resolve';
    const found = detectAutoEntities(text);
    // ftp://example.org — голый домен `example.org` внутри не размечается (перед ним «/»)
    expect(found).toEqual([]);
  });

  it('имена файлов и сокращения без известной зоны — не ссылки', () => {
    const text = 'файл report.txt, т.е. ничего, version 1.2.3';
    expect(detectAutoEntities(text)).toEqual([]);
  });

  it('кириллический домен и .onion', () => {
    const text = 'пример.рф и abcdefghijklmnop.onion';
    expect(spans(text, detectAutoEntities(text))).toEqual([
      [ApiMessageEntityTypes.Url, 'пример.рф'],
      [ApiMessageEntityTypes.Url, 'abcdefghijklmnop.onion'],
    ]);
  });
});

describe('detectAutoEntities: почта, упоминания, хештеги', () => {
  it('почта не превращается в ссылку на домен', () => {
    const text = 'write to team.lead+x@example.org.';
    expect(spans(text, detectAutoEntities(text))).toEqual([
      [ApiMessageEntityTypes.Email, 'team.lead+x@example.org'],
    ]);
  });

  it('@ник и @ник@сервер; точка в конце предложения — не часть ника', () => {
    const text = 'спроси @Robin_7 или @kestrel@example.org, а ещё @nightjar.';
    expect(spans(text, detectAutoEntities(text))).toEqual([
      [ApiMessageEntityTypes.Mention, '@Robin_7'],
      [ApiMessageEntityTypes.Mention, '@kestrel@example.org'],
      [ApiMessageEntityTypes.Mention, '@nightjar'],
    ]);
  });

  it('однобуквенный ник и @ внутри слова — не упоминание', () => {
    const text = 'a@b @x mail@';
    expect(detectAutoEntities(text)).toEqual([]);
  });

  it('хештеги: буквы любых алфавитов, номер и C# — не хештеги', () => {
    const text = '#отпуск #trip_2026 #42 C# https://a.com/#frag';
    expect(spans(text, detectAutoEntities(text))).toEqual([
      [ApiMessageEntityTypes.Url, 'https://a.com/#frag'],
      [ApiMessageEntityTypes.Hashtag, '#отпуск'],
      [ApiMessageEntityTypes.Hashtag, '#trip_2026'],
    ]);
  });
});

describe('withAutoEntities', () => {
  it('не трогает код и уже размеченные ссылки, уживается с жирным', () => {
    const text = 'bold https://a.com code https://b.com link';
    const existing: ApiMessageEntity[] = [
      { type: ApiMessageEntityTypes.Bold, offset: 0, length: 18 },
      { type: ApiMessageEntityTypes.Code, offset: 24, length: 13 },
      { type: ApiMessageEntityTypes.TextUrl, offset: 38, length: 4, url: 'https://c.com' },
    ];
    const result = withAutoEntities(text, existing);
    expect(spans(text, result)).toEqual([
      [ApiMessageEntityTypes.Bold, 'bold https://a.com'],
      [ApiMessageEntityTypes.Url, 'https://a.com'],
      [ApiMessageEntityTypes.Code, 'https://b.com'],
      [ApiMessageEntityTypes.TextUrl, 'link'],
    ]);
  });

  it('частичное пересечение с форматированием — без разметки', () => {
    const text = 'go example.com now';
    const existing: ApiMessageEntity[] = [{ type: ApiMessageEntityTypes.Italic, offset: 0, length: 6 }];
    expect(withAutoEntities(text, existing)).toBe(existing);
  });

  it('без находок возвращает исходные entities, без текста — тоже', () => {
    expect(withAutoEntities('просто текст')).toBeUndefined();
    expect(withAutoEntities(undefined, [])).toEqual([]);
  });

  it('отправитель и получатель размечают одинаково', () => {
    const text = 'план на example.com #work @Robin_7';
    expect(withAutoEntities(text)).toEqual(withAutoEntities(text, undefined));
    expect(withAutoEntities(text)!.map((e) => e.type)).toEqual([
      ApiMessageEntityTypes.Url, ApiMessageEntityTypes.Hashtag, ApiMessageEntityTypes.Mention,
    ]);
  });
});
