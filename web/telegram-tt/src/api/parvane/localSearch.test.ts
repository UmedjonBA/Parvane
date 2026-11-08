import { describe, expect, it } from 'vitest';

import type { ApiMessage } from '../types';

import { findFirstMessageIdAfterDate, searchMessages } from './localSearch';

const msg = (id: number, date: number, content: ApiMessage['content'], chatId = 'c1'): ApiMessage => ({
  id, chatId, date, content, isOutgoing: false,
});

const photo = { mediaType: 'photo', id: 'p', date: 0, sizes: [] } as never;

describe('global search by type (A7)', () => {
  const history = [
    msg(1, 100, { photo }),
    msg(2, 300, { photo, text: { text: 'Sunset at the lake' } }, 'c2'),
    msg(3, 200, {
      document: {
        mediaType: 'document', id: 'd', fileName: 'Quarterly-Plan.pdf', mimeType: 'application/pdf', size: 1,
      },
    } as never),
    msg(4, 250, {
      audio: {
        mediaType: 'audio', id: 'a', size: 1, mimeType: 'audio/mpeg', duration: 1,
        title: 'Blue Night', performer: 'Kestrel',
      },
    } as never),
    msg(5, 260, { text: { text: 'see https://example.org' } }),
    msg(6, 270, { text: { text: 'plain words' } }),
  ];

  it('without a query a type tab shows the latest of that type from all chats', () => {
    expect(searchMessages(history, '', 'media').map((m) => m.id)).toEqual([2, 1]);
    expect(searchMessages(history, undefined, 'links').map((m) => m.id)).toEqual([5]);
    expect(searchMessages(history, '', 'text')).toEqual([]);
  });

  it('with a query matches caption, file name and track title', () => {
    expect(searchMessages(history, 'quarterly', 'documents').map((m) => m.id)).toEqual([3]);
    expect(searchMessages(history, 'kestrel', 'audio').map((m) => m.id)).toEqual([4]);
    expect(searchMessages(history, 'sunset', 'media').map((m) => m.id)).toEqual([2]);
    expect(searchMessages(history, 'words', 'text').map((m) => m.id)).toEqual([6]);
  });
});

describe('jump to date (A5)', () => {
  const history = [msg(10, 1000, {}), msg(11, 2000, {}), msg(12, 1990, {}), msg(13, 3000, {})];

  it('returns the earliest message at or after the date', () => {
    expect(findFirstMessageIdAfterDate(history, 1500)).toBe(12);
    expect(findFirstMessageIdAfterDate(history, 0)).toBe(10);
    expect(findFirstMessageIdAfterDate(history, 3000)).toBe(13);
  });

  it('a date after the whole history goes to the last message; empty chat — nothing', () => {
    expect(findFirstMessageIdAfterDate(history, 9999)).toBe(13);
    expect(findFirstMessageIdAfterDate([], 9999)).toBeUndefined();
  });
});

describe('search filters (B1 date, B2 chat kind, B3 author)', () => {
  const DAY = 86400;
  const history: ApiMessage[] = [
    { ...msg(1, DAY + 10, { text: { text: 'morning note' } }, 'u1'), senderId: 'u1' },
    { ...msg(2, DAY + 500, { text: { text: 'group hello' } }, '-g1'), senderId: 'u2' },
    { ...msg(3, 2 * DAY + 5, { text: { text: 'next day' } }, 'u1'), senderId: 'u1' },
    { ...msg(4, DAY + 600, { text: { text: 'channel post' } }, '-c1'), senderId: 'u3' },
    { ...msg(5, DAY + 700, { action: { mediaType: 'action', type: 'other' } } as never, '-g1'), senderId: 'u2' },
  ];
  const kindOf = (chatId: string) => (chatId === '-c1' ? 'channels' : chatId.startsWith('-') ? 'groups' : 'users');

  it('date without query returns all messages of that day (service ones skipped)', () => {
    const found = searchMessages(history, '', 'text', { minDate: DAY, maxDate: 2 * DAY });
    expect(found.map((m) => m.id)).toEqual([4, 2, 1]);
  });

  it('"messages from" keeps only the chosen chat kind', () => {
    expect(searchMessages(history, 'o', 'text', { context: 'users', chatKindOf: kindOf }).map((m) => m.id))
      .toEqual([1]);
    expect(searchMessages(history, 'o', 'text', { context: 'groups', chatKindOf: kindOf }).map((m) => m.id))
      .toEqual([2]);
    expect(searchMessages(history, 'post', 'text', { context: 'channels', chatKindOf: kindOf }).map((m) => m.id))
      .toEqual([4]);
  });

  it('"from user" works with and without query', () => {
    expect(searchMessages(history, '', 'text', { fromId: 'u1' }).map((m) => m.id)).toEqual([3, 1]);
    expect(searchMessages(history, 'next', 'text', { fromId: 'u2' })).toEqual([]);
  });
});
