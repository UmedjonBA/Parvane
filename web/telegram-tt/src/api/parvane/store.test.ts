import { describe, expect, it } from 'vitest';

import type { ApiMessage } from '../types';
import type { WireStoredMessage } from './wire';

import { compareStoredOrder, ParvaneStore } from './store';

function message(chatId: string, id: number): ApiMessage {
  return {
    id, chatId, content: { text: { text: `m${id}` } }, date: Math.floor(id / 1000), isOutgoing: false,
  };
}

describe('ParvaneStore messages', () => {
  it('derives ids from time and keeps them unique per chat', () => {
    const store = new ParvaneStore();
    const a = store.allocateMessageId('c1', 'uuid-a', 1000);
    const b = store.allocateMessageId('c1', 'uuid-b', 1000);
    expect(a).toBe(1000000);
    expect(b).toBe(1000001);
    expect(store.allocateMessageId('c1', 'uuid-a', 1000)).toBe(a);
    expect(store.getUuidForMessage('c1', b)).toBe('uuid-b');
  });

  it('keeps the chat list sorted by id with an index for lookups', () => {
    const store = new ParvaneStore();
    [5000, 1000, 3000, 2000, 4000].forEach((id) => store.putMessage(message('c1', id)));
    expect(store.getMessages('c1').map((m) => m.id)).toEqual([1000, 2000, 3000, 4000, 5000]);
    store.putMessage({ ...message('c1', 3000), isPinned: true });
    expect(store.getMessages('c1')).toHaveLength(5);
    expect(store.getMessage('c1', 3000)?.isPinned).toBe(true);
    store.removeMessage('c1', 2000);
    expect(store.getMessages('c1').map((m) => m.id)).toEqual([1000, 3000, 4000, 5000]);
    expect(store.getMessage('c1', 2000)).toBeUndefined();
  });

  it('hasMessage reflects stored messages, not merely allocated ids', () => {
    const store = new ParvaneStore();
    const id = store.allocateMessageId('c1', 'uuid-x', 2000);
    expect(store.hasMessage('uuid-x')).toBe(false);
    store.putMessage(message('c1', id));
    expect(store.hasMessage('uuid-x')).toBe(true);
    expect(store.getMessageByUuid('uuid-x')?.id).toBe(id);
    store.removeMessage('c1', id);
    expect(store.hasMessage('uuid-x')).toBe(false);
  });

  // ORDER-1: часы собеседника отстают — его ответ всё равно ниже моего сообщения
  it('places a live message after everything already in the chat', () => {
    const store = new ParvaneStore();
    const now = Math.floor(Date.now() / 1000);
    const mine = store.allocateMessageId('c1', 'uuid-mine');
    const reply = store.allocateMessageId('c1', 'uuid-reply', now - 30);
    expect(reply).toBeGreaterThan(mine);
    // И наоборот: часы собеседника спешат — мой следующий ответ ниже его сообщения
    const ahead = store.allocateMessageId('c1', 'uuid-ahead', now + 40);
    expect(store.allocateMessageId('c1', 'uuid-next')).toBeGreaterThan(ahead);
    // Другой чат не затронут
    expect(store.allocateMessageId('c2', 'uuid-other', now - 30)).toBe((now - 30) * 1000);
  });

  it('keeps old messages ordered by time and restores a saved place', () => {
    const store = new ParvaneStore();
    const now = Math.floor(Date.now() / 1000);
    const mine = store.allocateMessageId('c1', 'uuid-mine');
    expect(store.allocateMessageId('c1', 'uuid-old', now - 3600)).toBe((now - 3600) * 1000);
    expect(store.allocateMessageId('c1', 'uuid-saved', now - 30, mine + 7)).toBe(mine + 7);
  });

  it('sorts restored rows by the saved place, then by time', () => {
    const row = (id: string, ts: number, order?: number) => ({
      id, from: 'a', to: 'b', content: { kind: 'text', text: id }, ts, order,
    }) as WireStoredMessage;
    const rows = [row('reply', 100, 130001), row('legacy', 90), row('mine', 130, 130000)];
    expect(rows.sort(compareStoredOrder).map((r) => r.id)).toEqual(['legacy', 'mine', 'reply']);
  });
});
