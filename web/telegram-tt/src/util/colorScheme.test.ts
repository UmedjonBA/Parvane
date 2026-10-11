import Color from 'colorjs.io';
import { describe, expect, it } from 'vitest';

import themeColors from '../styles/themes.json';
import { buildSchemeColors, COLOR_SCHEMES, getSchemeChatColors, getSchemeSwatches } from './colorScheme';

const WHITE = new Color('#ffffff');

describe('цветовые схемы', () => {
  it('«Telegram» ничего не заменяет', () => {
    expect(buildSchemeColors('telegram')).toEqual({});
    expect(getSchemeChatColors('telegram', 'dark')).toBeUndefined();
  });

  COLOR_SCHEMES.filter((scheme) => scheme !== 'telegram').forEach((scheme) => {
    it(`${scheme}: заменяет только известные переменные темы годными цветами`, () => {
      const colors = buildSchemeColors(scheme);
      expect(Object.keys(colors).length).toBeGreaterThan(40);
      Object.entries(colors).forEach(([property, pair]) => {
        expect(themeColors, property).toHaveProperty(property);
        pair.forEach((value) => expect(() => new Color(value), `${property}: ${value}`).not.toThrow());
      });
    });

    it(`${scheme}: белый текст читается на акценте, основной — на панели`, () => {
      const colors = buildSchemeColors(scheme);
      [0, 1].forEach((mode) => {
        const accent = new Color(colors['--color-primary'][mode]);
        const panel = new Color(colors['--color-background'][mode]);
        const text = new Color(colors['--color-text'][mode]);
        expect(WHITE.contrast(accent, 'WCAG21'), `акцент, режим ${mode}`).toBeGreaterThan(3);
        expect(text.contrast(panel, 'WCAG21'), `текст, режим ${mode}`).toBeGreaterThan(4.5);
      });
    });

    it(`${scheme}: образцы и фон чата есть для обеих тем`, () => {
      (['light', 'dark'] as const).forEach((theme) => {
        expect(getSchemeSwatches(scheme, theme)).toHaveLength(4);
        expect(getSchemeChatColors(scheme, theme)?.background).toMatch(/^#/);
      });
    });
  });
});
