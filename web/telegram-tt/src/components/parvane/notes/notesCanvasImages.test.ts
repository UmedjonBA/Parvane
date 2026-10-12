import { describe, expect, it } from 'vitest';

import {
  CANVAS_IMAGE_MAX_BYTES, canvasImageSource, createCanvasImageCache, isCanvasImage,
} from './notesCanvasImages';

const BLOB = {
  fileId: 'f', key: 'k', nonce: 'n', capability: 'c', size: 1, chunks: 1, mime: 'image/jpeg', uploader: 'me',
};
const THUMB = {
  fileId: 't', nonce: 'n', capability: 'c', width: 320, height: 240,
};

function file(name: string, mime: string, size: number, hasThumb = true) {
  return {
    name, mime, size, blob: BLOB, thumb: hasThumb ? THUMB : undefined,
  } as unknown as Parameters<typeof canvasImageSource>[0];
}

function setup(keepMs = 100) {
  const timers: { run: () => void; ms: number; isCleared?: boolean }[] = [];
  const revoked: string[] = [];
  let count = 0;
  const cache = createCanvasImageCache({
    createUrl: () => `blob:${++count}`,
    revokeUrl: (url) => revoked.push(url),
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return timers[timers.length - 1];
    },
    clearTimer: (timer) => {
      if (timer) (timer as { isCleared?: boolean }).isCleared = true;
    },
    keepMs,
  });
  // Срок вышел: срабатывают таймеры, которые не отменены
  const expire = () => timers.splice(0).filter((timer) => !timer.isCleared).forEach((timer) => timer.run());
  return {
    cache, revoked, timers, expire,
  };
}

const blob = () => Promise.resolve(new Blob(['x']));

describe('холст: откуда карточка берёт картинку', () => {
  it('по умолчанию — сам файл, а не миниатюра', () => {
    expect(canvasImageSource(file('фото.jpg', 'image/jpeg', 5000000), 'full')).toBe('full');
    expect(canvasImageSource(file('снимок.PNG', '', 5000000), 'full')).toBe('full');
  });

  it('настройка «миниатюрами» оставляет миниатюру', () => {
    expect(canvasImageSource(file('фото.jpg', 'image/jpeg', 5000000), 'thumb')).toBe('thumb');
  });

  it('картинка без миниатюры в полном качестве видна, миниатюрами — значок', () => {
    expect(canvasImageSource(file('фото.jpg', 'image/jpeg', 5000, false), 'full')).toBe('full');
    expect(canvasImageSource(file('фото.jpg', 'image/jpeg', 5000, false), 'thumb')).toBe('none');
  });

  it('слишком большая картинка остаётся миниатюрой', () => {
    expect(canvasImageSource(file('карта.png', 'image/png', CANVAS_IMAGE_MAX_BYTES + 1), 'full')).toBe('thumb');
    expect(canvasImageSource(file('карта.png', 'image/png', CANVAS_IMAGE_MAX_BYTES), 'full')).toBe('full');
  });

  it('не картинка и файл без содержимого целиком не читаются', () => {
    expect(canvasImageSource(file('отчёт.pdf', 'application/pdf', 5000), 'full')).toBe('thumb');
    expect(canvasImageSource(file('схема.svg', 'image/svg+xml', 5000, false), 'full')).toBe('none');
    expect(canvasImageSource(undefined, 'full')).toBe('none');
    expect(isCanvasImage({ name: 'заметка.md', mime: 'text/markdown' })).toBe(false);
  });
});

describe('холст: адреса картинок в полном качестве', () => {
  it('файл читается один раз, сколько бы карточек и перерисовок его ни просило', async () => {
    const { cache } = setup();
    let loads = 0;
    const load = () => {
      loads++;
      return blob();
    };
    const urls = await Promise.all([cache.acquire('a', load), cache.acquire('a', load), cache.acquire('a', load)]);
    expect(urls).toEqual(['blob:1', 'blob:1', 'blob:1']);
    expect(loads).toBe(1);
  });

  it('адрес освобождается, когда карточек не осталось и срок вышел', async () => {
    const { cache, revoked, expire } = setup();
    await cache.acquire('a', blob);
    await cache.acquire('a', blob);
    cache.release('a');
    expire();
    expect(revoked).toEqual([]);
    cache.release('a');
    expect(revoked).toEqual([]);
    expire();
    expect(revoked).toEqual(['blob:1']);
    expect(cache.size).toBe(0);
  });

  it('карточка, вернувшаяся до срока, получает прежний адрес без чтения', async () => {
    const { cache, revoked, expire } = setup();
    let loads = 0;
    const load = () => {
      loads++;
      return blob();
    };
    await cache.acquire('a', load);
    cache.release('a');
    expect(await cache.acquire('a', load)).toBe('blob:1');
    expire();
    expect(revoked).toEqual([]);
    expect(loads).toBe(1);
  });

  it('после освобождения файл читается заново и получает новый адрес', async () => {
    const { cache, expire } = setup();
    await cache.acquire('a', blob);
    cache.release('a');
    expire();
    expect(await cache.acquire('a', blob)).toBe('blob:2');
  });

  it('лишнее освобождение чужую карточку адреса не лишает', async () => {
    const { cache, revoked, expire } = setup();
    await cache.acquire('a', blob);
    cache.release('b');
    expire();
    expect(revoked).toEqual([]);
    expect(cache.size).toBe(1);
  });

  it('непрочитанный файл не запоминается: следующая попытка читает снова', async () => {
    const { cache } = setup();
    expect(await cache.acquire('a', () => Promise.reject(new Error('offline')))).toBeUndefined();
    cache.release('a');
    expect(await cache.acquire('a', () => Promise.resolve(undefined))).toBeUndefined();
    cache.release('a');
    expect(await cache.acquire('a', blob)).toBe('blob:1');
  });

  it('карточка ушла, пока файл читался: адрес не создаётся', async () => {
    const { cache, revoked, expire } = setup();
    let finish: (value: Blob) => void = () => undefined;
    const pending = cache.acquire('a', () => new Promise<Blob>((resolve) => {
      finish = resolve;
    }));
    await Promise.resolve();
    cache.release('a');
    expire();
    finish(new Blob(['x']));
    expect(await pending).toBeUndefined();
    expect(revoked).toEqual([]);
    expect(cache.size).toBe(0);
  });
});
