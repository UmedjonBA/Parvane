import { describe, expect, it } from 'vitest';

import { isSafeEntityUrl, wireEntitiesToApi } from './entities';
import { safeBlobMime } from './media';
import { PollStore } from './polls';

// P-44: опросы — закрыть может только автор и только из чата опроса;
// entities — clamp и allowlist схем; Blob — allowlist MIME
describe('P-44: polls authorization', () => {
  it('only the author may close, votes only from the poll chat', () => {
    const polls = new PollStore();
    polls.register('p1', 'chat-a', 'q', ['x', 'y'], { author: 'alice@local' });
    expect(polls.canClose('p1', 'alice@local')).toBe(true);
    expect(polls.canClose('p1', 'mallory@local')).toBe(false);
    expect(polls.canClose('missing', 'alice@local')).toBe(false);
    expect(polls.isInChat('p1', 'chat-a')).toBe(true);
    expect(polls.isInChat('p1', 'chat-b')).toBe(false);
    // Опрос без автора (старый снапшот) закрыть нельзя никому
    polls.register('p2', 'chat-a', 'q', ['x']);
    expect(polls.canClose('p2', 'alice@local')).toBe(false);
  });
});

describe('P-44: entities', () => {
  it('drops unsafe text_url schemes and clamps ranges', () => {
    const entities = wireEntitiesToApi([
      { type: 'text_url', offset: 0, length: 4, data: 'javascript:alert(1)' },
      { type: 'text_url', offset: 0, length: 4, data: 'tg://resolve?domain=x' },
      { type: 'text_url', offset: 0, length: 4, data: 'https://example.com/' },
      { type: 'bold', offset: 2, length: 100 },
      { type: 'italic', offset: 50, length: 3 },
      { type: 'bold', offset: -5, length: 3 },
    ], 10)!;
    expect(entities.map((e) => `${e.type}:${e.offset}:${e.length}`)).toEqual([
      'MessageEntityTextUrl:0:4', 'MessageEntityBold:2:8', 'MessageEntityBold:0:3',
    ]);
    expect(isSafeEntityUrl('mailto:a@b.c')).toBe(true);
    expect(isSafeEntityUrl('data:text/html,x')).toBe(false);
    expect(isSafeEntityUrl('https://a\nb')).toBe(false);
  });
});

describe('P-44: blob MIME allowlist', () => {
  it('maps active content types to octet-stream', () => {
    expect(safeBlobMime('image/png')).toBe('image/png');
    expect(safeBlobMime('Video/MP4; codecs=x')).toBe('video/mp4');
    expect(safeBlobMime('text/html')).toBe('application/octet-stream');
    expect(safeBlobMime('image/svg+xml')).toBe('application/octet-stream');
    expect(safeBlobMime(undefined)).toBe('application/octet-stream');
  });
});
