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

describe('A0031: poll votes', () => {
  it('drops duplicate/out-of-range indexes, one choice unless multiple', () => {
    const polls = new PollStore();
    polls.register('s', 'c', 'q', ['x', 'y', 'z'], { author: 'a@l', isPublic: true });
    polls.applyVote('s', 'bob@l', [1, 1, 1, 7, -1, 2]);
    expect(polls.build('s')!.results.resultByOption['1'].votersCount).toBe(1);
    expect(polls.build('s')!.results.resultByOption['2'].votersCount).toBe(0);
    polls.register('m', 'c', 'q', ['x', 'y', 'z'], { isMultiple: true, isPublic: true });
    polls.applyVote('m', 'bob@l', [0, 0, 2, 9]);
    expect(polls.getVoters('m', 0)).toEqual(['bob@l']);
    expect(polls.build('m')!.results.resultByOption['0'].votersCount).toBe(1);
  });

  it('does not reveal voters of an anonymous poll', () => {
    const polls = new PollStore();
    polls.register('anon', 'c', 'q', ['x', 'y'], {});
    polls.applyVote('anon', 'bob@l', [0]);
    expect(polls.getVoters('anon', 0)).toEqual([]);
    expect(polls.build('anon')!.results.resultByOption['0'].votersCount).toBe(1);
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
