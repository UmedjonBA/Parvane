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

  it('takes placeholder texts for deleted and undecryptable messages from the dictionary', () => {
    const store = new ParvaneStore();
    store.self = 'me@local';
    const row = (id: string, extra: Partial<WireStoredMessage>) => ({
      id, from: 'peer@local', to: 'me@local', content: { kind: 'text', text: 'x' }, ts: 100, ...extra,
    });
    const textOf = (m: ApiMessage) => m.content.text?.text;
    // Словарь ещё не подгружен — английский запасной текст, не русская строка в коде
    expect(textOf(store.buildApiMessage(row('a', { deleted: true })))).toBe('🗑 Message deleted');
    const ru: Record<string, string> = {
      ParvaneMessageDeleted: '🗑 Сообщение удалено',
      ParvaneUndecryptable: '🔒 Не удалось расшифровать сообщение',
    };
    store.getLangString = (key) => ru[key];
    expect(textOf(store.buildApiMessage(row('b', { deleted: true })))).toBe('🗑 Сообщение удалено');
    const encrypted = row('c', { content: { kind: 'encrypted' } });
    expect(textOf(store.buildApiMessage(encrypted))).toBe('🔒 Не удалось расшифровать сообщение');
  });

  it('sorts restored rows by the saved place, then by time', () => {
    const row = (id: string, ts: number, order?: number) => ({
      id, from: 'a', to: 'b', content: { kind: 'text', text: id }, ts, order,
    }) as WireStoredMessage;
    const rows = [row('reply', 100, 130001), row('legacy', 90), row('mine', 130, 130000)];
    expect(rows.sort(compareStoredOrder).map((r) => r.id)).toEqual(['legacy', 'mine', 'reply']);
  });

  // REPORT-1: цитаты жалобы сверяются с собственной историей группы у админа
  it('builds a mod report card only from verified history of the group', () => {
    const store = new ParvaneStore();
    const hex = 'ab'.repeat(16);
    const group = `v2g:${hex}`;
    const member = 'bob@x.test';
    store.registerGroup({
      group_id: group,
      name: 'g',
      kind: 'group',
      created_by: member,
      members: [{ address: member, role: 'member' }, { address: 'eve@x.test', role: 'member' }],
      version: 1,
    });
    const chatId = store.getIdForAddress(group, 'group');
    const authorId = store.getIdForAddress('carol@x.test');
    const id = store.allocateMessageId(chatId, 'op-real', 1000);
    store.putMessage({
      id, chatId, senderId: authorId, content: { text: { text: 'real text' } }, date: 1000, isOutgoing: false,
    });
    const report = (from: string, ops: string[]) => store.buildApiMessage({
      id: 'r1',
      from,
      to: 'admin@x.test',
      ts: 2000,
      content: {
        kind: 'mod_report',
        text: 'fallback',
        report_group: { domain: 'x.test', id: Buffer.from(hex, 'hex').toString('base64') },
        reported: ops.map((op) => ({ op_id: op, author: 'dave@x.test', text: 'fake', ts: 1 })),
      },
    }).content;
    const ok = report(member, ['op-real', 'op-fake']);
    expect(ok.modReport?.messages).toEqual([
      { uuid: 'op-real', authorId, text: 'real text', date: 1000 },
    ]);
    // Не участник группы, либо ни одного сообщения из своей истории — только текст
    expect(report('mallory@x.test', ['op-real']).modReport).toBeUndefined();
    expect(report(member, ['op-fake']).modReport).toBeUndefined();
    expect(report(member, ['op-fake']).text?.text).toBe('fallback');
  });
});

describe('ParvaneStore ids', () => {
  const fnv = (value: string) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return String(hash >>> 1);
  };

  it('does not merge two different addresses whose 31-bit hashes collide', () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair && i < 400000; i++) {
      const address = `user${i}@local`;
      const id = fnv(address);
      const other = seen.get(id);
      if (other) pair = [other, address];
      else seen.set(id, address);
    }
    expect(pair).toBeDefined();
    const store = new ParvaneStore();
    const idA = store.getIdForAddress(pair![0], 'user');
    const idB = store.getIdForAddress(pair![1], 'user');
    expect(idB).not.toBe(idA);
    expect(store.getAddressForId(idA)).toBe(pair![0]);
    expect(store.getAddressForId(idB)).toBe(pair![1]);
    // повторный запрос даёт тот же id
    expect(store.getIdForAddress(pair![1], 'user')).toBe(idB);
  });
});
