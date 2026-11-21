import { describe, expect, it } from 'vitest';

import { getIsPermissionError, shouldOfferNotifyOnboard } from './permissionPrompt';

describe('разрешения', () => {
  it('экран уведомлений — один раз, после выбора модулей и пока браузер не ответил', () => {
    const base = { isShown: false, isModulesChosen: true, permission: 'default' as NotificationPermission };
    expect(shouldOfferNotifyOnboard(base)).toBe(true);
    expect(shouldOfferNotifyOnboard({ ...base, isShown: true })).toBe(false);
    expect(shouldOfferNotifyOnboard({ ...base, isModulesChosen: false })).toBe(false);
    expect(shouldOfferNotifyOnboard({ ...base, permission: 'granted' })).toBe(false);
    expect(shouldOfferNotifyOnboard({ ...base, permission: 'denied' })).toBe(false);
    expect(shouldOfferNotifyOnboard({ ...base, permission: undefined })).toBe(false);
  });

  it('отказ в доступе: NotAllowedError и отказ геопозиции; прочие ошибки — нет', () => {
    expect(getIsPermissionError(new DOMException('no', 'NotAllowedError'))).toBe(true);
    expect(getIsPermissionError(new DOMException('no', 'NotFoundError'))).toBe(false);
    expect(getIsPermissionError({ code: 1 })).toBe(true);
    expect(getIsPermissionError({ code: 2 })).toBe(false);
    expect(getIsPermissionError(undefined)).toBe(false);
  });
});
