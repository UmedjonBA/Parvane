import { describe, expect, it } from 'vitest';

import { pickEscrowKey } from './escrowKey';

describe('ключ копии корня для администратора (ID-03)', () => {
  it('без закреплённого в сборке ключа копии нет, что бы ни объявил сервер', () => {
    expect(pickEscrowKey('', 'c2VydmVyLWtleQ==')).toBe('');
    expect(pickEscrowKey('', '')).toBe('');
  });

  it('объявленный сервером ключ принимается только при совпадении с закреплённым', () => {
    expect(pickEscrowKey('cGlubmVk', 'cGlubmVk')).toBe('cGlubmVk');
    expect(pickEscrowKey('cGlubmVk', 'b3RoZXI=')).toBe('');
    expect(pickEscrowKey('cGlubmVk', '')).toBe('');
  });
});
