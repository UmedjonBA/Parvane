import { describe, expect, it } from 'vitest';

import { selectAccountCaches, selectAccountStorageKeys } from './deviceWipe';

const USER = 'vera@example.test';

describe('deviceWipe', () => {
  it('стирает данные аккаунта и его экранов, оставляет настройки устройства', () => {
    const keys = [
      'parvane:login-address', `parvane:pin-fails:${USER}`, `parvane:device:${USER}`, 'parvane:music-info',
      'parvane:music-offline', 'parvane:music-queue', 'parvane:planner-tab', 'parvane:translate-default',
      'parvane:diag:v2', 'parvane:color-scheme', 'parvane:modules', 'parvane:modules-view',
      'parvane:modules-server-off', 'parvane:modules-first-run', 'parvane:panel-widths', 'parvane:gateway',
      'parvane:chat-list-dense', 'parvane:e2e:ringTimeoutMs', 'parvane:notify-onboard',
      'tt-active-tab', `other:${USER}`,
    ];
    expect(selectAccountStorageKeys(keys, USER)).toEqual([
      'parvane:login-address', `parvane:pin-fails:${USER}`, `parvane:device:${USER}`, 'parvane:music-info',
      'parvane:music-offline', 'parvane:music-queue', 'parvane:planner-tab', 'parvane:translate-default',
      'parvane:diag:v2', `other:${USER}`,
    ]);
  });

  it('без адреса (выход до входа) стирает только ключи parvane', () => {
    expect(selectAccountStorageKeys(['parvane:section', 'tt-active-tab'], undefined)).toEqual(['parvane:section']);
  });

  it('оставляет оболочку приложения и языковые пакеты, остальные кэши стирает', () => {
    expect(selectAccountCaches([
      'tt-assets', 'tt-lang-packs-v52', 'tt-media', 'tt-media-avatars', 'tt-media-progressive', 'tt-custom-bg',
      'parvane-music-offline',
    ])).toEqual(['tt-media', 'tt-media-avatars', 'tt-media-progressive', 'tt-custom-bg', 'parvane-music-offline']);
  });
});
