import { describe, expect, it } from 'vitest';

import type { WireStoredMessage } from './wire';

import { v2ToWire, wireToV2 } from './v2/contentMap';
import { applyForwardOptions } from './forwardOptions';
import { ParvaneStore } from './store';

const photoContent = {
  photo: { mediaType: 'photo', id: 'f1', date: 0, sizes: [] },
  text: { text: 'Harbor at dawn' },
} as never;

describe('forward options (A3)', () => {
  it('default: forwarded header with the author', () => {
    const wire: Record<string, unknown> = { kind: 'photo', file_id: 'f1', caption: 'Harbor at dawn' };
    const out = applyForwardOptions(wire, photoContent, { address: 'otto@local', name: 'Otto' }, {});
    expect(out.hasForwardHeader).toBe(true);
    expect(wire.forwarded_from).toBe('otto@local');
    expect(wire.forwarded_name).toBe('Otto');
    expect(wire.caption).toBe('Harbor at dawn');
  });

  it('hide sender name: a plain copy without forwarded_*', () => {
    const wire: Record<string, unknown> = { kind: 'text', text: 'hello' };
    const out = applyForwardOptions(wire, { text: { text: 'hello' } }, { address: 'otto@local', name: 'Otto' }, {
      noAuthors: true,
    });
    expect(out.hasForwardHeader).toBe(false);
    expect(wire).toEqual({ kind: 'text', text: 'hello' });
    expect(wireToV2(wire as never).forward).toBeUndefined();
  });

  it('hide captions: media goes without caption (and without author), text stays', () => {
    const wire: Record<string, unknown> = {
      kind: 'photo', file_id: 'f1', caption: 'Harbor at dawn', entities: [{ type: 'bold', offset: 0, length: 3 }],
    };
    const out = applyForwardOptions(wire, photoContent, { address: 'otto@local' }, { noCaptions: true });
    expect(wire.caption).toBeUndefined();
    expect(wire.entities).toBeUndefined();
    expect(out.content.text).toBeUndefined();
    expect(out.content.photo).toBeDefined();
    expect(out.hasForwardHeader).toBe(false);
    const text: Record<string, unknown> = { kind: 'text', text: 'keep me' };
    applyForwardOptions(text, { text: { text: 'keep me' } }, {}, { noCaptions: true });
    expect(text.text).toBe('keep me');
  });
});

describe('send without sound (A4)', () => {
  it('silent survives the v2 content round trip and marks the received message silent', () => {
    const wire: Record<string, unknown> = { kind: 'text', text: 'shh' };
    applyForwardOptions(wire, { text: { text: 'shh' } }, {}, { isSilent: true, noAuthors: true });
    const v2 = wireToV2(wire as never);
    expect(v2.silent).toBe(true);
    const back = v2ToWire(v2)!;
    expect(back.silent).toBe(true);
    const store = new ParvaneStore();
    store.self = 'me@local';
    const stored: WireStoredMessage = {
      id: '0190a7a2-0000-7000-8000-000000000001', from: 'otto@local', to: 'me@local', ts: 1000, content: back,
    };
    expect(store.buildApiMessage(stored).isSilent).toBe(true);
    const loud = { ...stored, content: v2ToWire(wireToV2({ kind: 'text', text: 'hey' }))! };
    expect(store.buildApiMessage(loud).isSilent).toBeUndefined();
  });
});
