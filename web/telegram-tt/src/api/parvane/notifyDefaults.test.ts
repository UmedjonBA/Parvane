import { describe, expect, it } from 'vitest';

import {
  mergeNotifyDefault, soundFromState, soundToState, withNotifyDefaults,
} from './notifyDefaults';

// Те же правила, что `global/helpers/notifications.ts` (getIsChatSilent / getShouldShowMessagePreview): умолчания
// типа, поверх — исключение чата; беззвучно — `!hasSound`, текст — `shouldShowPreviews`
type Settings = { hasSound?: boolean; shouldShowPreviews?: boolean };
const getIsChatSilent = (_chat: unknown, defaults: Record<string, Settings>) => !defaults.users.hasSound;
const getShouldShowMessagePreview = (_chat: unknown, defaults: Record<string, Settings>) => (
  Boolean(defaults.users.shouldShowPreviews)
);
const privateChat = { id: '123', type: 'chatTypePrivate', title: 'Mira' };

describe('notification defaults (A1)', () => {
  it('first run: sound and message preview are on, like Telegram server defaults', () => {
    const defaults = withNotifyDefaults({});
    expect(getIsChatSilent(privateChat, defaults)).toBe(false);
    expect(getShouldShowMessagePreview(privateChat, defaults)).toBe(true);
    expect(defaults.groups).toEqual({ hasSound: true, shouldShowPreviews: true });
  });

  it('stored choice wins over defaults; undefined fields do not erase them', () => {
    const defaults = withNotifyDefaults({
      users: { shouldShowPreviews: false, hasSound: undefined, mutedUntil: 0 },
      groups: { hasSound: false },
    });
    expect(defaults.users).toEqual({ hasSound: true, shouldShowPreviews: false, mutedUntil: 0 });
    expect(getIsChatSilent(privateChat, defaults)).toBe(false);
    expect(getShouldShowMessagePreview(privateChat, defaults)).toBe(false);
    expect(defaults.groups.hasSound).toBe(false);
  });

  it('editing previews keeps the saved sound flag', () => {
    const next = mergeNotifyDefault({ hasSound: false, mutedUntil: 5 }, { mutedUntil: 0, shouldShowPreviews: true });
    expect(next).toEqual({ hasSound: false, mutedUntil: 0, shouldShowPreviews: true });
  });

  it('hasSound round-trips through state.v1 NotifySettings.sound', () => {
    expect(soundFromState(soundToState(true))).toBe(true);
    expect(soundFromState(soundToState(false))).toBe(false);
    expect(soundToState(undefined)).toBeUndefined();
    expect(soundFromState(undefined)).toBeUndefined();
  });
});
