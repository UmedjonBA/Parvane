import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import {
  readCanvasImageQuality, readGraphFilter, readGraphPlaces, writeCanvasImageQuality, writeGraphFilter,
  writeGraphPlaces,
} from './notesPrefs';

describe('настройки «Знаний»: картинки на холсте', () => {
  let saved: Record<string, string>;

  beforeEach(() => {
    saved = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved[key],
      setItem: (key: string, value: string) => {
        saved[key] = value;
      },
      removeItem: (key: string) => {
        delete saved[key];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('область графа запоминается; «все заметки» без скрытий не хранится; негодная запись — все заметки', () => {
    expect(readGraphFilter()).toEqual({ scope: { kind: 'all' }, hideOrphans: false, hideMissing: false });
    writeGraphFilter({ scope: { kind: 'around', note: 'n1', depth: 2 }, hideOrphans: true, hideMissing: false });
    expect(readGraphFilter())
      .toEqual({ scope: { kind: 'around', note: 'n1', depth: 2 }, hideOrphans: true, hideMissing: false });
    writeGraphFilter({ scope: { kind: 'all' }, hideOrphans: false, hideMissing: false });
    expect(saved['parvane:knowledge-graph-filter']).toBeUndefined();
    saved['parvane:knowledge-graph-filter'] = '{"scope":{"kind":"around","depth":9}}';
    expect(readGraphFilter().scope).toEqual({ kind: 'all' });
    saved['parvane:knowledge-graph-filter'] = 'не json';
    expect(readGraphFilter().scope).toEqual({ kind: 'all' });
  });

  it('ручная расстановка графа — своя у каждой области; пустая не хранится, мусор отбрасывается', () => {
    writeGraphPlaces('all', { a: { x: 10, y: -20 } });
    writeGraphPlaces('folder:Железо', { b: { x: 1, y: 2 } });
    expect(readGraphPlaces('all')).toEqual({ a: { x: 10, y: -20 } });
    expect(readGraphPlaces('folder:Железо')).toEqual({ b: { x: 1, y: 2 } });
    expect(readGraphPlaces('tag:нет')).toEqual({});
    writeGraphPlaces('all', {});
    expect(readGraphPlaces('all')).toEqual({});
    expect(readGraphPlaces('folder:Железо')).toEqual({ b: { x: 1, y: 2 } });
    writeGraphPlaces('folder:Железо', {});
    expect(saved['parvane:knowledge-graph-places']).toBeUndefined();
    saved['parvane:knowledge-graph-places'] = '{"all":{"a":{"x":"1","y":2},"b":{"x":3,"y":4}}}';
    expect(readGraphPlaces('all')).toEqual({ b: { x: 3, y: 4 } });
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
