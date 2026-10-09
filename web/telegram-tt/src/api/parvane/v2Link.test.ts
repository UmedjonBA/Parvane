import { describe, expect, it } from 'vitest';

import { PvClient } from '../../lib/parvane-protocol/parvane_protocol';
import {
  deriveBundleKey, openKeyBundle, readGrantBundleKey, sealKeyBundle, withBundleKey, withFreshLog,
} from './v2/keyBundle';

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

  // spec 015: материал привязки лежит в копии ключей аккаунта под ключом
  // восстановления; новое устройство берёт его оттуда, подставляет свежий журнал
  // с сервера и входит в журнал устройств — прежние устройства остаются
  it('материал из копии ключей аккаунта принимается движком', async () => {
    const first = new PvClient(SELF, 'd1', 'local');
    first.createIdentity(2);
    first.ensureStateKey();
    const bundleKey = (await deriveBundleKey('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ-0123-4567', SELF))!;
    const stored = withBundleKey(first.linkGrantMaterial(), 'a2V5');
    const sealed = await sealKeyBundle(bundleKey, SELF, { grant: Buffer.from(stored).toString('base64') });

    const opened = (await openKeyBundle(bundleKey, SELF, sealed))!;
    const grant = new Uint8Array(Buffer.from(opened.grant, 'base64'));
    // «Свежий журнал с сервера» — тот же журнал в том же виде (ответ log_sync)
    const logHex = (JSON.parse(new TextDecoder().decode(grant)) as { log: string }).log;
    const material = withFreshLog(grant, new Uint8Array(Buffer.from(logHex, 'hex')));
    expect(readGrantBundleKey(material)).toBe('a2V5');

    const second = new PvClient(SELF, 'd2', 'local');
    const requests = second.joinWithGrant(material, 2) as { method: string }[];
    // Вступление — один запрос: его можно безопасно повторять после обрыва связи
    expect(requests.map((r) => r.method)).toEqual(['identity.device.publish_certificate']);
    expect(second.hasStateKey()).toBe(true);
    expect((JSON.parse(second.logDevices(SELF)) as { v2: string[] }).v2.sort()).toEqual(['d1', 'd2']);
    first.free();
    second.free();
  });

  it('материал с чужим журналом движок отвергает', () => {
    const first = new PvClient(SELF, 'd1', 'local');
    first.createIdentity(2);
    const stranger = new PvClient(SELF, 'x1', 'local');
    stranger.createIdentity(2);
    const strangerLog = (JSON.parse(new TextDecoder().decode(stranger.linkGrantMaterial())) as { log: string }).log;
    const forged = withFreshLog(first.linkGrantMaterial(), new Uint8Array(Buffer.from(strangerLog, 'hex')));
    const second = new PvClient(SELF, 'd2', 'local');
    expect(() => second.joinWithGrant(forged, 2)).toThrow();
    first.free();
    stranger.free();
    second.free();
  });

  it('устройство без SSK грант не выдаёт', () => {
    const fresh = new PvClient(SELF, 'd3', 'local');
    expect(() => fresh.linkGrantMaterial()).toThrow();
    fresh.free();
  });
});
