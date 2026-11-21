import { describe, expect, it } from 'vitest';

import { formatHotkey, matchGlobalHotkey } from './globalHotkeys';

function press(code: string, key: string, extra: Partial<KeyboardEvent> = {}) {
  return {
    code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra,
  };
}

describe('globalHotkeys', () => {
  it('Ctrl+1 … 7 — модуль по порядку, 8 и 9 — нет', () => {
    expect(matchGlobalHotkey(press('Digit1', '1', { ctrlKey: true }), false)).toEqual({ kind: 'module', index: 0 });
    expect(matchGlobalHotkey(press('Digit7', '7', { ctrlKey: true }), false)).toEqual({ kind: 'module', index: 6 });
    expect(matchGlobalHotkey(press('Digit8', '8', { ctrlKey: true }), false)).toBeUndefined();
  });

  it('цифра в русской раскладке и без модификатора', () => {
    expect(matchGlobalHotkey(press('Digit2', '"', { ctrlKey: true }), false)).toEqual({ kind: 'module', index: 1 });
    expect(matchGlobalHotkey(press('Digit2', '2'), false)).toBeUndefined();
  });

  it('Ctrl+Shift+цифра оставлена папкам чатов', () => {
    expect(matchGlobalHotkey(press('Digit2', '@', { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
  });

  it('Ctrl+, — настройки, Ctrl+/ — справка, Ctrl+Пробел — музыка', () => {
    expect(matchGlobalHotkey(press('Comma', 'б', { ctrlKey: true }), false)).toEqual({ kind: 'settings' });
    expect(matchGlobalHotkey(press('Slash', '.', { ctrlKey: true }), false)).toEqual({ kind: 'help' });
    expect(matchGlobalHotkey(press('Slash', '?', { ctrlKey: true, shiftKey: true }), false)).toEqual({ kind: 'help' });
    expect(matchGlobalHotkey(press('Space', ' ', { ctrlKey: true }), false)).toEqual({ kind: 'music' });
  });

  it('macOS — ⌘, а Ctrl там не наш', () => {
    expect(matchGlobalHotkey(press('Digit3', '3', { metaKey: true }), true)).toEqual({ kind: 'module', index: 2 });
    expect(matchGlobalHotkey(press('Digit3', '3', { ctrlKey: true }), true)).toBeUndefined();
    expect(matchGlobalHotkey(press('Digit3', '3', { metaKey: true }), false)).toBeUndefined();
  });

  it('Alt снимает сочетание', () => {
    expect(matchGlobalHotkey(press('Comma', ',', { ctrlKey: true, altKey: true }), false)).toBeUndefined();
  });

  it('подпись для macOS', () => {
    expect(formatHotkey('Ctrl+1 … 7', true)).toBe('⌘1 … 7');
    expect(formatHotkey('Ctrl+K', false)).toBe('Ctrl+K');
  });
});
