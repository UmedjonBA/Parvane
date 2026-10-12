import { describe, expect, it } from 'vitest';

import {
  buildCombinationSlug, findGradient, getDefaultGradient, getGradientAverageColor, getGradientInk, gradientCss,
  GRADIENTS, isDarkGradient, parseBackgroundSlug, PATTERN_IDS, pickCombination,
} from './wallpaperCombo';

describe('идентификатор сочетания «цвет + рисунок»', () => {
  it('собирается и разбирается обратно для каждой пары', () => {
    GRADIENTS.forEach(({ id }) => PATTERN_IDS.forEach((pattern) => {
      const slug = buildCombinationSlug({ gradient: id, pattern });
      expect(parseBackgroundSlug(slug)).toEqual({ gradient: id, pattern });
    }));
  });

  it('не похож на свою картинку и на прежние идентификаторы, годится для медиа-кэша', () => {
    const slug = buildCombinationSlug({ gradient: 'night', pattern: 'science-mix' });
    expect(slug).toBe('combo-night_science-mix');
    expect(slug.startsWith('wp')).toBe(false);
    expect(slug.startsWith('builtin-')).toBe(false);
    expect(slug).toMatch(/^[\w-]+$/);
  });

  it('прежние фоны с узором остаются той же парой', () => {
    expect(parseBackgroundSlug('builtin-pattern-night')).toEqual({ gradient: 'night', pattern: 'mathematics' });
    expect(parseBackgroundSlug('builtin-pattern-plum')).toEqual({ gradient: 'plum', pattern: 'programming' });
    expect(parseBackgroundSlug('builtin-pattern-pine')).toEqual({ gradient: 'pine', pattern: 'cosmos' });
    expect(parseBackgroundSlug('builtin-pattern-coal')).toEqual({ gradient: 'coal', pattern: 'physics' });
    expect(parseBackgroundSlug('builtin-pattern-meadow')).toEqual({ gradient: 'meadow', pattern: 'biology' });
    expect(parseBackgroundSlug('builtin-pattern-dawn')).toEqual({ gradient: 'dawn', pattern: 'electronics' });
    expect(parseBackgroundSlug('builtin-pattern-lagoon')).toEqual({ gradient: 'lagoon', pattern: 'algorithms' });
    expect(parseBackgroundSlug('builtin-pattern-lilac')).toEqual({ gradient: 'lilac', pattern: 'flight' });
  });

  it('прежние градиенты остаются той же парой', () => {
    expect(parseBackgroundSlug('builtin-dusk')).toEqual({ gradient: 'dusk', pattern: 'chemistry' });
    expect(parseBackgroundSlug('builtin-forest')).toEqual({ gradient: 'forest', pattern: 'biology' });
    expect(parseBackgroundSlug('builtin-ocean')).toEqual({ gradient: 'ocean', pattern: 'electronics' });
    expect(parseBackgroundSlug('builtin-ember')).toEqual({ gradient: 'ember', pattern: 'algorithms' });
    expect(parseBackgroundSlug('builtin-lavender')).toEqual({ gradient: 'lavender', pattern: 'science-mix' });
    expect(parseBackgroundSlug('builtin-mint')).toEqual({ gradient: 'mint', pattern: 'science-mix' });
    expect(parseBackgroundSlug('builtin-sand')).toEqual({ gradient: 'sand', pattern: 'mathematics' });
    expect(parseBackgroundSlug('builtin-sky')).toEqual({ gradient: 'sky', pattern: 'programming' });
    expect(parseBackgroundSlug('builtin-rose')).toEqual({ gradient: 'rose', pattern: 'cosmos' });
    expect(parseBackgroundSlug('builtin-graphite')).toEqual({ gradient: 'graphite', pattern: 'flight' });
  });

  it('каждый градиент имеет ровно один прежний идентификатор', () => {
    GRADIENTS.forEach(({ id }) => {
      const found = [`builtin-pattern-${id}`, `builtin-${id}`].filter((slug) => parseBackgroundSlug(slug));
      expect(found).toHaveLength(1);
    });
  });

  it('чужое и негодное не разбирается', () => {
    [
      undefined, '', '#aabbcc', 'wpabc123', 'combo-night', 'combo-night_', 'combo-nope_cosmos', 'combo-night_nope',
      'combo-night_cosmos_x', 'builtin-night', 'builtin-pattern-dusk', 'builtin-', 'builtin-constructor',
      'builtin-pattern-toString',
    ].forEach((slug) => expect(parseBackgroundSlug(slug)).toBeUndefined());
  });
});

describe('выбор одного из двух', () => {
  it('меняет только выбранное, второе остаётся', () => {
    const current = { gradient: 'plum', pattern: 'cosmos' } as const;
    expect(pickCombination(current, { gradient: 'sky' }, 'dark')).toEqual({ gradient: 'sky', pattern: 'cosmos' });
    expect(pickCombination(current, { pattern: 'flight' }, 'dark')).toEqual({ gradient: 'plum', pattern: 'flight' });
  });

  it('без текущего сочетания подставляет градиент темы и рисунок по умолчанию', () => {
    expect(pickCombination(undefined, { pattern: 'physics' }, 'dark'))
      .toEqual({ gradient: 'night', pattern: 'physics' });
    expect(pickCombination(undefined, { pattern: 'physics' }, 'light'))
      .toEqual({ gradient: 'lagoon', pattern: 'physics' });
    expect(pickCombination(undefined, { gradient: 'rose' }, 'light'))
      .toEqual({ gradient: 'rose', pattern: 'science-mix' });
  });

  it('градиент темы существует и подходит ей по яркости', () => {
    expect(isDarkGradient(findGradient(getDefaultGradient('dark'))!)).toBe(true);
    expect(isDarkGradient(findGradient(getDefaultGradient('light'))!)).toBe(false);
  });
});

describe('градиент', () => {
  it('идентификаторы не повторяются и не содержат разделителя', () => {
    const ids = GRADIENTS.map(({ id }) => id);
    expect(ids).toHaveLength(18);
    expect(new Set(ids).size).toBe(18);
    ids.forEach((id) => expect(id).toMatch(/^[a-z]+$/));
  });

  it('CSS повторяет холст: угол от направления «вверх», точки цвета сжаты к середине', () => {
    // 135° холста — диагональ: линия CSS длиннее стороны в √2 раз
    expect(gradientCss(findGradient('night')!))
      .toBe('linear-gradient(225deg, #1b2338 14.6%, #101626 50%, #232f4d 85.4%)');
    // Вдоль оси линии совпадают — точки на краях
    expect(gradientCss({
      id: 'x', colors: ['#000000', '#ffffff'], angle: 0, ink: '#ffffff', inkAlpha: 0.2,
    })).toBe('linear-gradient(90deg, #000000 0%, #ffffff 100%)');
    expect(gradientCss({
      id: 'x', colors: ['#000000', '#ffffff'], angle: 270, ink: '#ffffff', inkAlpha: 0.2,
    })).toBe('linear-gradient(0deg, #000000 0%, #ffffff 100%)');
  });

  it('средний цвет — среднее точек', () => {
    expect(getGradientAverageColor({
      id: 'x', colors: ['#000000', '#ffffff', '#808080'], angle: 0, ink: '#ffffff', inkAlpha: 0.2,
    })).toBe('#808080');
  });

  it('рисунок светлый на тёмном градиенте и тёмный на светлом', () => {
    GRADIENTS.forEach((preset) => {
      const ink = getGradientInk(preset);
      expect(`${preset.id}:${ink.color === '#ffffff'}`).toBe(`${preset.id}:${isDarkGradient(preset)}`);
      expect(ink.alpha).toBeGreaterThan(0.1);
      expect(ink.alpha).toBeLessThan(0.5);
    });
  });
});
