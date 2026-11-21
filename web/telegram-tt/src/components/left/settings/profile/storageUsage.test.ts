import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../api/gramjs', () => ({ callApi: vi.fn() }));
vi.mock('../../../parvane/music/musicOffline', () => ({ getOfflineBytes: () => 0, removeOffline: vi.fn() }));

const { getCacheKind } = await import('./storageUsage');

describe('getCacheKind', () => {
  it('медиа чатов — все кэши `tt-media*`', () => {
    expect(getCacheKind('tt-media')).toBe('media');
    expect(getCacheKind('tt-media-avatars_2')).toBe('media');
    expect(getCacheKind('tt-media-progressive')).toBe('media');
  });

  it('оболочку приложения, свой фон, «Поделиться» и музыку не трогает', () => {
    expect(getCacheKind('tt-assets')).toBeUndefined();
    expect(getCacheKind('tt-custom-bg')).toBeUndefined();
    expect(getCacheKind('parvane-share')).toBeUndefined();
    expect(getCacheKind('parvane-music-offline')).toBeUndefined();
  });

  it('остальное — прочий кэш', () => {
    expect(getCacheKind('tt-lang-packs-v52')).toBe('other');
  });
});
