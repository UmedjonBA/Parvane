import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { getGatewayUrl } from './gateway';

// WEB-09: адрес gateway из localStorage — только в диагностической сборке. В обычной запись в хранилище
// (расширение, XSS) не уводит вход на чужой сервер
const values = new Map<string, string>();

describe('адрес gateway', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => {
    values.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('обычная сборка не читает переопределение из localStorage', () => {
    localStorage.setItem('parvane:gateway', 'ws://evil.example:1/ws');
    expect(getGatewayUrl()).not.toContain('evil.example');
  });

  it('диагностическая сборка (сценарии) берёт адрес стенда', () => {
    vi.stubEnv('VITE_PARVANE_DIAG_HOOKS', '1');
    localStorage.setItem('parvane:gateway', 'ws://stand.example:9222/ws');
    expect(getGatewayUrl()).toBe('ws://stand.example:9222/ws');
  });
});
