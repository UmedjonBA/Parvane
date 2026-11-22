import Color from 'colorjs.io';
import { describe, expect, it } from 'vitest';

import themeColors from '../styles/themes.json';
import {
  buildSchemeColors, buildSchemeTokens, COLOR_SCHEMES, getSchemeChatColors, getSchemeSwatches,
} from './colorScheme';

const WHITE = new Color('#ffffff');

// Токены макета `local-workdirs/design-2026-11-17/parvane-design/pv.css`: [светлая, тёмная]
const PV_CSS: Record<string, [string, string]> = {
  '--pv-bg': ['#ebdbb2', '#1d2021'],
  '--pv-panel': ['#fbf1c7', '#282828'],
  '--pv-raised': ['#f2e5bc', '#32302f'],
  '--pv-line': ['#e3d4ae', '#3c3836'],
  '--pv-line2': ['#d5c4a1', '#504945'],
  '--pv-fg': ['#3c3836', '#ebdbb2'],
  '--pv-muted': ['#665c54', '#a89984'],
  '--pv-accent': ['#b57614', '#fabd2f'],
  '--pv-at': ['#8a5a0b', '#fabd2f'],
  '--pv-accent-ink': ['#fbf1c7', '#1d2021'],
  '--pv-blue': ['#076678', '#83a598'],
  '--pv-purple': ['#8f3f71', '#d3869b'],
  '--pv-orange': ['#af3a03', '#fe8019'],
  '--pv-aqua': ['#427b58', '#8ec07c'],
  '--pv-green': ['#79740e', '#b8bb26'],
  '--pv-red': ['#9d0006', '#fb4934'],
};
const TELEGRAM_PANEL = { light: '#ffffff', dark: '#212121' };
const TONE_NAMES = ['--pv-blue', '--pv-purple', '--pv-orange', '--pv-aqua', '--pv-green', '--pv-red', '--pv-yellow'];

describe('цветовые схемы', () => {
  it('тона своих разделов есть у каждой схемы в обеих темах; тёмный текст читается на акценте', () => {
    COLOR_SCHEMES.forEach((scheme) => {
      (['light', 'dark'] as const).forEach((theme) => {
        const tokens = buildSchemeTokens(scheme, theme);
        expect(Object.keys(tokens).length, scheme).toBeGreaterThan(20);
        const accent = new Color(tokens['--pv-accent']);
        const ink = new Color(tokens['--pv-accent-ink']);
        expect(ink.contrast(accent, 'WCAG21'), `${scheme} ${theme}`).toBeGreaterThan(3);
      });
    });
  });

  it('Gruvbox повторяет токены макета pv.css в обеих темах', () => {
    (['light', 'dark'] as const).forEach((theme, index) => {
      const tokens = buildSchemeTokens('gruvbox', theme);
      Object.entries(PV_CSS).forEach(([property, pair]) => {
        expect(tokens[property], `${property} ${theme}`).toBe(pair[index]);
      });
    });
  });

  it('набор переменных своих экранов один у всех схем; акцент текстом читается на панели', () => {
    const names = Object.keys(buildSchemeTokens('gruvbox', 'light')).sort();
    COLOR_SCHEMES.forEach((scheme) => {
      (['light', 'dark'] as const).forEach((theme) => {
        const tokens = buildSchemeTokens(scheme, theme);
        expect(Object.keys(tokens).sort(), `${scheme} ${theme}`).toEqual(names);
        Object.entries(tokens).forEach(([property, value]) => expect(value, `${scheme} ${property}`).toBeTruthy());
        const panel = new Color(scheme === 'telegram' ? TELEGRAM_PANEL[theme] : tokens['--pv-panel']);
        expect(new Color(tokens['--pv-at']).contrast(panel, 'WCAG21'), `${scheme} ${theme}`).toBeGreaterThan(4.5);
      });
    });
  });

  it('тона видов записей и кнопка с акцентом читаются в обеих темах', () => {
    COLOR_SCHEMES.forEach((scheme) => {
      (['light', 'dark'] as const).forEach((theme) => {
        const tokens = buildSchemeTokens(scheme, theme);
        const panel = new Color(scheme === 'telegram' ? TELEGRAM_PANEL[theme] : tokens['--pv-panel']);
        TONE_NAMES.forEach((name) => {
          expect(new Color(tokens[name]).contrast(panel, 'WCAG21'), `${scheme} ${theme} ${name}`).toBeGreaterThan(3);
        });
        const ink = new Color(tokens['--pv-accent-ink']);
        expect(ink.contrast(new Color(tokens['--pv-at']), 'WCAG21'), `${scheme} ${theme}`).toBeGreaterThan(4.5);
        if (scheme !== 'telegram') {
          expect(new Color(tokens['--pv-muted']).contrast(panel, 'WCAG21'), `${scheme} ${theme}`).toBeGreaterThan(4);
        }
      });
    });
  });

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

    it(`${scheme}: время и акцент своего сообщения читаются на его фоне`, () => {
      const colors = buildSchemeColors(scheme);
      [0, 1].forEach((mode) => {
        const own = new Color(colors['--color-background-own'][mode]);
        ['--color-message-meta-own', '--color-accent-own'].forEach((property) => {
          expect(new Color(colors[property][mode]).contrast(own, 'WCAG21'), `${property}, режим ${mode}`)
            .toBeGreaterThan(3);
        });
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
