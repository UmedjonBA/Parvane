import { describe, expect, it } from 'vitest';

import { getIsAutoLockDue, getIsLockHotkey } from './autoLock';

const MINUTE = 60_000;

const key = (patch: Partial<KeyboardEvent>) => ({
  key: 'l', code: 'KeyL', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch,
});

describe('autoLock', () => {
  it('блокирует, когда без действий прошёл срок, и не блокирует при выключенной автоблокировке', () => {
    expect(getIsAutoLockDue(0, 5 * MINUTE - 1, 5)).toBe(false);
    expect(getIsAutoLockDue(0, 5 * MINUTE, 5)).toBe(true);
    expect(getIsAutoLockDue(0, 10 * 60 * MINUTE, 0)).toBe(false);
  });

  it('Ctrl+L и ⌘L — блокировка; с Shift или Alt и без модификатора — нет', () => {
    expect(getIsLockHotkey(key({ ctrlKey: true }))).toBe(true);
    expect(getIsLockHotkey(key({ metaKey: true }))).toBe(true);
    // Раскладка с другой буквой на той же клавише
    expect(getIsLockHotkey(key({ ctrlKey: true, key: 'д' }))).toBe(true);
    expect(getIsLockHotkey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(getIsLockHotkey(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(getIsLockHotkey(key({}))).toBe(false);
  });
});
