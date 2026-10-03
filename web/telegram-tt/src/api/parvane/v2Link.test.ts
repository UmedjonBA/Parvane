import { describe, expect, it } from 'vitest';

import { PvClient } from '../../lib/parvane-protocol/parvane_protocol';

// Линковка второго устройства по v2 (LINK-1 v2, spec 007): грант старого
// устройства несёт SSK, журнал устройств, ключ доставки и ключ личного
// состояния; новое устройство по нему сертифицирует себя и читает журнал
// состояния. Формат материала общий с C ABI (`backend/protocol/src/host.rs`).

const SELF = 'alice@local';

describe('v2: грант линковки второго устройства', () => {
  it('новое устройство вступает по гранту и получает ключ личного состояния', () => {
    const first = new PvClient(SELF, 'd1', 'local');
    first.createIdentity(2);
    expect(first.ensureStateKey()).toBe(true);
    const material = first.linkGrantMaterial();
    const parsed = JSON.parse(new TextDecoder().decode(material)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['dk', 'gen', 'log', 'pk', 'sk', 'skv', 'ssk']);

    const second = new PvClient(SELF, 'd2', 'local');
    expect(second.hasStateKey()).toBe(false);
    const requests = second.joinWithGrant(material, 2) as { method: string }[];
    expect(requests.map((r) => r.method)).toContain('identity.device.publish_certificate');
    // Ключ доставки общий для устройств пользователя — второй раз не ставится
    expect(requests.map((r) => r.method)).not.toContain('identity.delivery_key.set');
    expect(second.hasStateKey()).toBe(true);
    expect(second.ensureStateKey()).toBe(false);
    expect((JSON.parse(second.logDevices(SELF)) as { v2: string[] }).v2.sort()).toEqual(['d1', 'd2']);
    first.free();
    second.free();
  });

  it('устройство без SSK грант не выдаёт', () => {
    const fresh = new PvClient(SELF, 'd3', 'local');
    expect(() => fresh.linkGrantMaterial()).toThrow();
    fresh.free();
  });
});
