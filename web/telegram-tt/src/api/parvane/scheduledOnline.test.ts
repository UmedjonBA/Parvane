import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { V2Content } from './v2/contentMap';

import { SCHEDULED_WHEN_ONLINE } from '../../config';
import { decodeMessage, encodeMessage, initSync } from '../../lib/parvane-protocol/parvane_protocol';
import { contentOfWire, wireOfContent } from './v2/contentMap';
import { SCHEDULED_UNTIL_ONLINE, selectDueScheduled } from './localState';

const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');
const NOW = 1_800_000_000;

// Хвосты этапа 2 (LEFTOVERS): «Отправить, когда будет в сети» как у desktop и отложенный текст «без звука»
describe('scheduled: send when online (desktop parity)', () => {
  it('the marker is the one desktop writes (0x7FFFFFFE s, send_at_ms 2147483646000) and tt uses', () => {
    expect(SCHEDULED_UNTIL_ONLINE).toBe(0x7FFFFFFE);
    expect(SCHEDULED_UNTIL_ONLINE).toBe(SCHEDULED_WHEN_ONLINE);
    expect(SCHEDULED_UNTIL_ONLINE * 1000).toBe(2147483646000);
  });

  it('"when online" fires only when the peer is online; dated ones by time', () => {
    const queue = [
      { chatId: 'a', scheduledAt: SCHEDULED_UNTIL_ONLINE },
      { chatId: 'b', scheduledAt: SCHEDULED_UNTIL_ONLINE },
      { chatId: 'c', scheduledAt: NOW - 1 },
      { chatId: 'd', scheduledAt: NOW + 60 },
    ];
    const due = selectDueScheduled(queue, NOW, (chatId) => chatId === 'b');
    expect(due.map((e) => e.chatId)).toEqual(['b', 'c']);
    expect(selectDueScheduled(queue, NOW, () => false).map((e) => e.chatId)).toEqual(['c']);
  });
});

describe('scheduled text without sound', () => {
  it('silent travels inside the serialized Content of ScheduledMessage', () => {
    initSync({ module: readFileSync(WASM) });
    const content = contentOfWire({ kind: 'text', text: 'позже', silent: true });
    const bytes = encodeMessage('parvane.msg.v2.Content', JSON.stringify(content));
    const back = wireOfContent(JSON.parse(decodeMessage('parvane.msg.v2.Content', bytes)) as V2Content);
    expect(back).toMatchObject({ kind: 'text', text: 'позже', silent: true });
  });
});
