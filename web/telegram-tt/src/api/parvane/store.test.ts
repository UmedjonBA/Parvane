import { describe, expect, it } from 'vitest';

import type { ApiMessage } from '../types';

import { ParvaneStore } from './store';

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
});
