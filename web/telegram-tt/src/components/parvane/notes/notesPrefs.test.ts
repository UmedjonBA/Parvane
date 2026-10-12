import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { readCanvasImageQuality, writeCanvasImageQuality } from './notesPrefs';

describe('настройки «Знаний»: картинки на холсте', () => {
  let saved: Record<string, string>;

  beforeEach(() => {
    saved = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved[key],
      setItem: (key: string, value: string) => {
        saved[key] = value;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('по умолчанию картинки в полном качестве', () => {
    expect(readCanvasImageQuality()).toBe('full');
  });

  it('выбор «миниатюрами» запоминается на устройстве и снимается обратно', () => {
    writeCanvasImageQuality('thumb');
    expect(readCanvasImageQuality()).toBe('thumb');
    writeCanvasImageQuality('full');
    expect(readCanvasImageQuality()).toBe('full');
  });

  it('незнакомое значение и недоступное хранилище — полное качество', () => {
    saved['parvane:knowledge-canvas-images'] = 'tiny';
    expect(readCanvasImageQuality()).toBe('full');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    writeCanvasImageQuality('thumb');
    expect(readCanvasImageQuality()).toBe('full');
  });
});
