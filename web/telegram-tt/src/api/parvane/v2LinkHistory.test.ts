import { describe, expect, it } from 'vitest';

import type { WireStoredMessage } from './wire';

import { collectV2History, parseV2History, V2_HISTORY_LIMIT } from './v2/linkHistory';

function row(id: string, ts: number, extra: Partial<WireStoredMessage> = {}): WireStoredMessage {
  return {
    id, from: 'alice@local', to: 'bob@local', ts, content: { kind: 'text', text: id }, origin: 'v2', ...extra,
  };
}

describe('LINK-1 п. 8: история v2-эпохи в экспорте линковки (T138)', () => {
  it('в экспорт идут все расшифрованные строки кэша — без дублей, удалённых, шифртекста и TTL', () => {
    const history = [
      row('b', 20),
      // строка эпохи v1 (без origin): с T110 переносится — иначе ей неоткуда взяться
      row('v1', 5, { origin: undefined }),
      row('gone', 6, { deleted: true }),
      row('enc', 7, { content: { kind: 'encrypted' } }),
      row('genc', 7, { origin: undefined, content: { kind: 'group_encrypted' } }),
      row('ttl', 8, { content: { kind: 'text', text: 't', ttl_secs: 5 } }),
      // режим чата принимается только из v2 (isForgedChatMode) — из v1 не переносим
      row('mode-v1', 9, { origin: undefined, content: { kind: 'chat_mode', mode: 'plain' } as never }),
      row('mode-v2', 11, { content: { kind: 'chat_mode', mode: 'plain' } as never }),
    ];
    const journal = [row('a', 10, { read: true, updated_at: 3 }), row('b', 20)];
    const out = collectV2History(history, journal);
    expect(out.map((m) => m.id)).toEqual(['v1', 'a', 'mode-v2', 'b']);
    // служебные поля устройства в экспорт не уезжают
    expect(out[1]).not.toHaveProperty('origin');
    expect(out[1].read).toBe(true);
    expect(out[1]).not.toHaveProperty('updated_at');
    expect(out[0]).not.toHaveProperty('origin');
  });

  it('экспорт режется до потолка, остаются самые свежие', () => {
    const many = Array.from({ length: V2_HISTORY_LIMIT + 3 }, (_, i) => row(`m${i}`, i));
    const out = collectV2History(many);
    expect(out).toHaveLength(V2_HISTORY_LIMIT);
    expect(out[0].id).toBe('m3');
  });

  it('новое устройство читает строки как v2 и пропускает битые', () => {
    const exported = collectV2History([row('a', 10, { reply_to: 'x' }), row('g', 11, { to: 'v2g:00ff' })]);
    const state = JSON.stringify({
      linkVersion: 2,
      decCache: {},
      v2History: [...exported, { id: '', from: 'a', to: 'b', ts: 1, content: { kind: 'text' } },
        { id: 'bad', ts: 'x' }, 7, { id: 'enc', from: 'a', to: 'b', ts: 1, content: { kind: 'group_encrypted' } }],
    });
    const rows = parseV2History(state);
    expect(rows.map((m) => m.id)).toEqual(['a', 'g']);
    expect(rows.every((m) => m.origin === 'v2')).toBe(true);
    expect(rows[0].reply_to).toBe('x');
  });

  it('экспорт без поля и мусор вместо JSON — пустая история', () => {
    expect(parseV2History(JSON.stringify({ linkVersion: 2, decCache: {} }))).toEqual([]);
    expect(parseV2History('{')).toEqual([]);
    expect(parseV2History(JSON.stringify({ v2History: 'nope' }))).toEqual([]);
  });
});
