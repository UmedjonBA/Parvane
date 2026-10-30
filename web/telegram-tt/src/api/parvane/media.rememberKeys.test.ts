import { describe, expect, it, vi } from 'vitest';

import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { createMediaService } from './media';

vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.CSS = { ...(window.CSS || {}), supports: () => false };
});
vi.mock('./gateway', () => ({ getV2Bridge: () => ({ control: {} }) }));
vi.mock('../gramjs', () => ({ callApi: () => Promise.resolve(undefined), cancelApiProgress: () => undefined }));

function create() {
  return createMediaService({
    getConnection: () => ({}) as unknown as GatewayConnection,
    getStore: () => ({ self: 'bob@local' }) as unknown as ParvaneStore,
    getToken: () => 'token',
  });
}

describe('rememberKeys: чужое сообщение не подменяет ключи известного вложения', () => {
  it('второй ключ для того же file_id игнорируется, секрет остаётся прежним', () => {
    const service = create();
    service.rememberKeys({
      kind: 'photo', file_id: 'f1', file_key: 'key-a', file_nonce: 'nonce-a', capability: 'cap-a', mime: 'image/png',
    });
    service.rememberKeys({
      kind: 'photo', file_id: 'f1', file_key: 'key-b', file_nonce: 'nonce-b', capability: 'cap-b', mime: 'image/gif',
    });
    expect(service.getMediaKeys('f1')).toEqual({ keyB64: 'key-a', nonceB64: 'nonce-a' });
    expect(service.getCapability('f1')).toBe('cap-a');
  });

  it('повтор того же ключа (пересылка) проходит', () => {
    const service = create();
    const content = {
      kind: 'photo' as const, file_id: 'f2', file_key: 'k', file_nonce: 'n', capability: 'cap',
    };
    service.rememberKeys(content);
    service.rememberKeys({ ...content, capability: 'cap2' });
    expect(service.getCapability('f2')).toBe('cap2');
  });
});
