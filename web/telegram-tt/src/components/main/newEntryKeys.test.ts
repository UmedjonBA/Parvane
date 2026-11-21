import { describe, expect, it } from 'vitest';

import { isNewEntryHotkey, selectNewEntryAction } from './newEntryKeys';

function key(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: 'n', code: 'KeyN', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...overrides,
  } as KeyboardEvent;
}

describe('isNewEntryHotkey', () => {
  it('Ctrl+N и Cmd+N, в том числе в русской раскладке', () => {
    expect(isNewEntryHotkey(key())).toBe(true);
    expect(isNewEntryHotkey(key({ ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isNewEntryHotkey(key({ key: 'т' }))).toBe(true);
  });

  it('без модификатора, с Shift или Alt — не наше', () => {
    expect(isNewEntryHotkey(key({ ctrlKey: false }))).toBe(false);
    expect(isNewEntryHotkey(key({ shiftKey: true }))).toBe(false);
    expect(isNewEntryHotkey(key({ altKey: true }))).toBe(false);
    expect(isNewEntryHotkey(key({ key: 'm', code: 'KeyM' }))).toBe(false);
  });
});

describe('selectNewEntryAction', () => {
  it('по модулю', () => {
    expect(selectNewEntryAction('chats')).toBe('message');
    expect(selectNewEntryAction('notes')).toBe('note');
    expect(selectNewEntryAction('plan')).toBe('plan');
    expect(selectNewEntryAction('files')).toBe('inPlace');
    expect(selectNewEntryAction('profile')).toBe('inPlace');
  });
});
