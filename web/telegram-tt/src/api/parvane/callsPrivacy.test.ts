import { describe, expect, it } from 'vitest';

import { FALLBACK_ICE_SERVERS } from './callengine';
import { pickIceTransportPolicy } from './calls';

// WEB-14: звонок может скрыть IP (только TURN), а без ICE-конфигурации сервера сторонний STUN не используется
describe('приватность звонков', () => {
  it('«только через сервер» — relay, иначе по умолчанию браузера', () => {
    expect(pickIceTransportPolicy(true, false)).toBe('relay');
    expect(pickIceTransportPolicy(false, true)).toBe('relay');
    expect(pickIceTransportPolicy(false, false)).toBeUndefined();
  });

  it('запасной список ICE — без сторонних серверов', () => {
    expect(FALLBACK_ICE_SERVERS).toEqual([]);
  });
});
