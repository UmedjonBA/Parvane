import Color from 'colorjs.io';

import type { ThemeKey } from '../types';

import { createSignal } from './signals';

// Parvane (spec 019, 041 A6): цветовая схема приложения. Схема — две палитры (светлая и тёмная) из десятка
// тонов; из них выводятся переменные `--color-*` поверх `styles/themes.json` («Telegram» — без замен) и
// переменные `--pv-*` своих экранов. Gruvbox повторяет токены макета (`pv.css`) значение в значение;
// остальные схемы задают тот же набор переменных. Размеры и радиусы макета от схемы не зависят —
// они в `styles/_variables.scss`. Настройка устройства: localStorage, читается до первой отрисовки
export type ColorScheme = 'gruvbox' | 'telegram' | 'nord' | 'catppuccin' | 'solarized';
export const COLOR_SCHEMES: ColorScheme[] = ['gruvbox', 'telegram', 'nord', 'catppuccin', 'solarized'];
export const DEFAULT_COLOR_SCHEME: ColorScheme = 'gruvbox';

type Palette = {
  // Фон вокруг панелей и фон чата
  bg: string;
  // Панели, списки, сообщения собеседника
  panel: string;
  raised: string;
  hover: string;
  line: string;
  lineStrong: string;
  text: string;
  muted: string;
  faint: string;
  // Заливка кнопок и активного чата: поверх неё текст белый, поэтому тон не светлее среднего
  accent: string;
  // Ссылки и акцентный текст на панели
  link: string;
  // Своё сообщение и акцент внутри него
  own: string;
  ownAccent: string;
};

type SchemeColors = Record<string, [light: string, dark: string]>;

// Тона прототипа для своих разделов («План», «Знания»): яркий акцент с тёмным текстом на нём и цвета
// видов записей. Отдаются переменными `--pv-*`; у мессенджера свой акцент (`--color-primary`) — на нём
// текст белый, поэтому он темнее
type Tones = {
  accent: string;
  // Акцент текстом и значком на панели (`--at` макета): тот же тон, но читаемый на светлом фоне
  accentText: string;
  accentInk: string;
  blue: string;
  purple: string;
  orange: string;
  aqua: string;
  green: string;
  red: string;
  yellow: string;
};

// Цвета мессенджера по смыслу (ошибка, успех, выделение), которых нет в `themes.json`: у «Telegram» — прежние
// значения `styles/_variables.scss`, у остальных схем — тона схемы
type Semantic = {
  error: string;
  warning: string;
  success: string;
  selection: string;
};

const TELEGRAM_SEMANTIC: Semantic = {
  error: '#e53935',
  warning: '#fb8c00',
  success: '#4fae4e',
  selection: '#3993fb',
};

// Тёмная палитра «Telegram» (`themes.json`, вторые значения) — для экранов, которые всегда тёмные
const TELEGRAM_DARK: Pick<Palette, 'bg' | 'panel' | 'raised' | 'lineStrong' | 'text' | 'muted' | 'faint'> = {
  bg: '#0f0f0f',
  panel: '#212121',
  raised: '#2c2c2c',
  lineStrong: '#3b3b3d',
  text: '#ffffff',
  muted: '#aaaaaa',
  faint: '#717579',
};

const STORAGE_KEY = 'parvane:color-scheme';
const MARK_SHARE = '35%';
const WAVE_FILL_ALPHA = '66';
const FLAT_BACKGROUND_CLASS = 'color-scheme-flat';
const LIGHT = 0;
const DARK = 1;

const PALETTES: Record<Exclude<ColorScheme, 'telegram'>, [light: Palette, dark: Palette]> = {
  gruvbox: [{
    bg: '#ebdbb2',
    panel: '#fbf1c7',
    raised: '#f2e5bc',
    hover: '#efe1b6',
    line: '#e3d4ae',
    lineStrong: '#d5c4a1',
    text: '#3c3836',
    muted: '#665c54',
    faint: '#a89984',
    accent: '#b57614',
    link: '#076678',
    own: '#eeddA0',
    ownAccent: '#79740e',
  }, {
    bg: '#1d2021',
    panel: '#282828',
    raised: '#32302f',
    hover: '#3c3836',
    line: '#3c3836',
    lineStrong: '#504945',
    text: '#ebdbb2',
    muted: '#a89984',
    faint: '#7c6f64',
    accent: '#d65d0e',
    link: '#fabd2f',
    own: '#504945',
    ownAccent: '#fabd2f',
  }],
  nord: [{
    bg: '#d8dee9',
    panel: '#eceff4',
    raised: '#e5e9f0',
    hover: '#dfe4ec',
    line: '#d8dee9',
    lineStrong: '#c5cddb',
    text: '#2e3440',
    muted: '#5b6578',
    faint: '#8a94a8',
    accent: '#5e81ac',
    link: '#5e81ac',
    own: '#cfe3ea',
    ownAccent: '#4c6f99',
  }, {
    bg: '#242933',
    panel: '#2e3440',
    raised: '#3b4252',
    hover: '#434c5e',
    line: '#3b4252',
    lineStrong: '#4c566a',
    text: '#eceff4',
    muted: '#a3adbf',
    faint: '#6c7689',
    accent: '#5e81ac',
    link: '#88c0d0',
    own: '#434c5e',
    ownAccent: '#88c0d0',
  }],
  catppuccin: [{
    bg: '#dce0e8',
    panel: '#eff1f5',
    raised: '#e6e9ef',
    hover: '#dfe2ea',
    line: '#ccd0da',
    lineStrong: '#bcc0cc',
    text: '#4c4f69',
    muted: '#6c6f85',
    faint: '#9ca0b0',
    accent: '#8839ef',
    link: '#1e66f5',
    own: '#e0d5f7',
    ownAccent: '#2d7a1d',
  }, {
    bg: '#11111b',
    panel: '#1e1e2e',
    raised: '#313244',
    hover: '#2a2b3c',
    line: '#313244',
    lineStrong: '#45475a',
    text: '#cdd6f4',
    muted: '#a6adc8',
    faint: '#6c7086',
    accent: '#8f6bd9',
    link: '#cba6f7',
    own: '#45475a',
    ownAccent: '#cba6f7',
  }],
  solarized: [{
    bg: '#eee8d5',
    panel: '#fdf6e3',
    raised: '#f5efdc',
    hover: '#f0ead8',
    line: '#e4ddc8',
    lineStrong: '#d3cbb7',
    // Основной текст и подписи темнее канонических base00/base0: те не дотягивают до читаемости на base3
    text: '#2f474e',
    muted: '#586e75',
    faint: '#93a1a1',
    accent: '#268bd2',
    link: '#268bd2',
    own: '#f1e5bb',
    ownAccent: '#5f6d00',
  }, {
    bg: '#00212b',
    panel: '#002b36',
    raised: '#073642',
    hover: '#0a4050',
    line: '#073642',
    lineStrong: '#1a4b58',
    text: '#a9b7b7',
    muted: '#7f9296',
    faint: '#586e75',
    accent: '#268bd2',
    link: '#2aa198',
    own: '#0d4857',
    ownAccent: '#2aa198',
  }],
};

const TONES: Record<ColorScheme, [light: Tones, dark: Tones]> = {
  gruvbox: [{
    accent: '#b57614',
    accentText: '#8a5a0b',
    accentInk: '#fbf1c7',
    blue: '#076678',
    purple: '#8f3f71',
    orange: '#af3a03',
    aqua: '#427b58',
    green: '#79740e',
    red: '#9d0006',
    yellow: '#b57614',
  }, {
    accent: '#fabd2f',
    accentText: '#fabd2f',
    accentInk: '#1d2021',
    blue: '#83a598',
    purple: '#d3869b',
    orange: '#fe8019',
    aqua: '#8ec07c',
    green: '#b8bb26',
    red: '#fb4934',
    yellow: '#fabd2f',
  }],
  telegram: [{
    accent: '#3390ec',
    accentText: '#1c6fb5',
    accentInk: '#ffffff',
    blue: '#3390ec',
    purple: '#8b5a96',
    orange: '#d9730d',
    aqua: '#2f7772',
    green: '#44774a',
    red: '#e53935',
    yellow: '#b8860b',
  }, {
    accent: '#8774e1',
    accentText: '#9d8df0',
    // На светлом фиолетовом белый текст не читается — тёмный, как у остальных тёмных схем
    accentInk: '#0f0f0f',
    blue: '#6ab3f3',
    purple: '#cb86db',
    orange: '#f5a25d',
    aqua: '#6ff9f0',
    green: '#8eee98',
    red: '#fb6f5f',
    yellow: '#ffd67e',
  }],
  nord: [{
    accent: '#5e81ac',
    accentText: '#3f6591',
    accentInk: '#eceff4',
    blue: '#5e81ac',
    purple: '#8f6a8a',
    orange: '#b8654f',
    aqua: '#4b7d7e',
    green: '#617c4e',
    red: '#bf616a',
    yellow: '#8f7025',
  }, {
    accent: '#88c0d0',
    accentText: '#88c0d0',
    accentInk: '#2e3440',
    blue: '#81a1c1',
    purple: '#b48ead',
    orange: '#d08770',
    aqua: '#8fbcbb',
    green: '#a3be8c',
    red: '#cb7d85',
    yellow: '#ebcb8b',
  }],
  catppuccin: [{
    accent: '#8839ef',
    accentText: '#7527d9',
    accentInk: '#eff1f5',
    blue: '#1e66f5',
    purple: '#8839ef',
    orange: '#c94f09',
    aqua: '#148288',
    green: '#368624',
    red: '#d20f39',
    yellow: '#a56915',
  }, {
    accent: '#cba6f7',
    accentText: '#cba6f7',
    accentInk: '#1e1e2e',
    blue: '#89b4fa',
    purple: '#cba6f7',
    orange: '#fab387',
    aqua: '#94e2d5',
    green: '#a6e3a1',
    red: '#f38ba8',
    yellow: '#f9e2af',
  }],
  solarized: [{
    accent: '#268bd2',
    accentText: '#1a6fb0',
    accentInk: '#fdf6e3',
    blue: '#268bd2',
    purple: '#6c71c4',
    orange: '#cb4b16',
    aqua: '#238780',
    green: '#708100',
    red: '#dc322f',
    yellow: '#987300',
  }, {
    accent: '#2aa198',
    accentText: '#2aa198',
    accentInk: '#002b36',
    blue: '#268bd2',
    purple: '#797ec9',
    orange: '#d26437',
    aqua: '#2aa198',
    green: '#859900',
    red: '#e25552',
    yellow: '#b58900',
  }],
};

const [getColorScheme, setColorSchemeSignal] = createSignal<ColorScheme>(readStoredColorScheme());

export { getColorScheme };

export function readStoredColorScheme(): ColorScheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as ColorScheme;
    return COLOR_SCHEMES.includes(saved) ? saved : DEFAULT_COLOR_SCHEME;
  } catch {
    // Хранилище недоступно (приватное окно) — схема по умолчанию
    return DEFAULT_COLOR_SCHEME;
  }
}

// Класс на <html>: у схем, кроме «Telegram», фон чата — ровный цвет схемы, без зелёной картинки
export function applyColorSchemeClass(scheme: ColorScheme) {
  document.documentElement.classList.toggle(FLAT_BACKGROUND_CLASS, scheme !== 'telegram');
}

export function storeColorScheme(scheme: ColorScheme) {
  setColorSchemeSignal(scheme);
  applyColorSchemeClass(scheme);
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    // Выбор действует до закрытия вкладки
  }
}

function mix(from: string, to: string, ratio: number) {
  return new Color(from).mix(new Color(to), ratio, { space: 'srgb' }).toString({ format: 'hex' });
}

function buildMode(p: Palette, t: Tones): Record<string, string> {
  const shade = mix(p.accent, '#000000', 0.14);
  const accentTint = mix(p.panel, p.accent, 0.12);
  const ownTint = mix(p.own, p.text, 0.14);
  return {
    '--color-primary': p.accent,
    '--color-primary-opacity': `${p.accent}1E`,
    '--color-primary-opacity-hover': `${p.accent}40`,
    '--color-primary-tint': `${p.accent}1a`,
    '--color-primary-shade': shade,
    '--color-background': p.panel,
    '--color-background-compact-menu': `${p.panel}DD`,
    '--color-background-compact-menu-reactions': `${p.panel}EB`,
    '--color-background-secondary': p.bg,
    '--color-background-secondary-accent': p.raised,
    '--color-background-sidebar': p.bg,
    '--color-background-own': p.own,
    '--color-background-own-apple': p.own,
    '--color-background-selected': p.raised,
    '--color-background-own-selected': mix(p.own, p.accent, 0.25),
    '--color-chat-hover': p.hover,
    '--color-chat-active': p.accent,
    '--color-chat-active-greyed': mix(p.accent, p.panel, 0.25),
    '--color-item-hover': p.hover,
    '--color-item-active': p.raised,
    '--color-text': p.text,
    '--color-text-secondary': p.muted,
    '--color-icon-secondary': p.muted,
    '--color-text-secondary-apple': p.muted,
    '--color-borders': p.line,
    '--color-borders-input': p.lineStrong,
    '--color-dividers': p.lineStrong,
    '--color-dividers-android': p.line,
    '--color-links': p.link,
    '--color-gray': p.faint,
    '--color-list-icon': p.faint,
    '--color-active': p.accent,
    '--color-active-darker': shade,
    '--color-text-meta-colored': p.link,
    '--color-reply-hover': p.hover,
    '--color-reply-active': p.raised,
    '--color-reply-own-hover': mix(p.own, p.text, 0.08),
    '--color-reply-own-hover-apple': mix(p.own, p.text, 0.08),
    '--color-reply-own-active': ownTint,
    '--color-reply-own-active-apple': ownTint,
    '--color-accent-own': p.ownAccent,
    '--color-message-meta-own': mix(p.own, p.text, 0.7),
    '--color-own-links': p.ownAccent,
    '--color-code': p.link,
    '--color-code-own': p.ownAccent,
    '--color-composer-button': `${p.muted}CC`,
    '--color-message-reaction': accentTint,
    '--color-message-reaction-hover': mix(p.panel, p.accent, 0.22),
    '--color-message-reaction-own': ownTint,
    '--color-message-reaction-hover-own': mix(p.own, p.text, 0.22),
    '--color-message-reaction-chosen-hover': shade,
    '--color-message-reaction-chosen-hover-own': p.ownAccent,
    '--color-voice-transcribe-button': accentTint,
    '--color-voice-transcribe-button-own': ownTint,
    '--color-chat-username': p.link,
    '--color-borders-read-story': p.faint,
    '--color-forum-unread-topic-hover': p.hover,
    '--color-forum-hover-unread-topic-hover': p.raised,
    '--color-green': t.green,
    '--color-green-darker': mix(t.green, '#000000', 0.16),
    '--color-success': t.green,
  };
}

/** Замены переменных темы для схемы; у «Telegram» замен нет. */
export function buildSchemeColors(scheme: ColorScheme): SchemeColors {
  if (scheme === 'telegram') return {};
  const [light, dark] = PALETTES[scheme].map((palette, index) => buildMode(palette, TONES[scheme][index]));
  return Object.fromEntries(Object.keys(light).map((property) => [property, [light[property], dark[property]]]));
}

/** Фон чата и цвет узора схемы; `undefined` — прежние цвета мессенджера. */
export function getSchemeChatColors(scheme: ColorScheme, theme: ThemeKey) {
  if (scheme === 'telegram') return undefined;
  const palette = PALETTES[scheme][theme === 'dark' ? DARK : LIGHT];
  return { background: palette.bg, pattern: `${palette.lineStrong}99`, panel: palette.panel };
}

/** Цвета волны голосового сообщения (рисуется на canvas, переменные CSS недоступны): входящего и своего.
 * `undefined` — прежние цвета мессенджера. */
export function getSchemeWaveColors(scheme: ColorScheme, theme: ThemeKey) {
  if (scheme === 'telegram') return undefined;
  const palette = PALETTES[scheme][theme === 'dark' ? DARK : LIGHT];
  return {
    fill: `${palette.link}${WAVE_FILL_ALPHA}`,
    progress: palette.link,
    fillOwn: `${palette.ownAccent}${WAVE_FILL_ALPHA}`,
    progressOwn: palette.ownAccent,
  };
}

/** Образцы схемы для выбора в настройках. */
export function getSchemeSwatches(scheme: ColorScheme, theme: ThemeKey) {
  if (scheme === 'telegram') {
    return theme === 'dark'
      ? ['#0F0F0F', '#212121', '#8774E1', '#FFFFFF'] : ['#E4E4E5', '#FFFFFF', '#3390EC', '#000000'];
  }
  const index = theme === 'dark' ? DARK : LIGHT;
  const palette = PALETTES[scheme][index];
  // Акцент своих экранов (`--pv-accent`), как у образцов макета: у тёмной Gruvbox он жёлтый, а не оранжевый
  return [palette.bg, palette.panel, TONES[scheme][index].accent, palette.text];
}

/** Переменные `--pv-*` своих экранов — имена токенов `pv.css` с приставкой: акцент, цвета видов записей и
 * нейтральные тона. Набор один для всех схем и обеих тем; у «Telegram» нейтральные тона берутся из
 * переменных мессенджера. */
export function buildSchemeTokens(scheme: ColorScheme, theme: ThemeKey): Record<string, string> {
  const index = theme === 'dark' ? DARK : LIGHT;
  const tones = TONES[scheme][index];
  const palette = scheme === 'telegram' ? undefined : PALETTES[scheme][index];
  const darkPalette = scheme === 'telegram' ? TELEGRAM_DARK : PALETTES[scheme][DARK];
  const semantic: Semantic = scheme === 'telegram' ? TELEGRAM_SEMANTIC : {
    error: tones.red, warning: tones.orange, success: tones.green, selection: tones.accent,
  };
  return {
    ...buildSemanticColors(semantic),
    // Подсветка найденного текста
    '--pv-mark': `color-mix(in srgb, ${tones.yellow} ${MARK_SHARE}, transparent)`,
    // Тёмная палитра схемы при любой теме — для экранов, которые всегда тёмные (видеозвонок, просмотр файла)
    '--pv-dk-bg': darkPalette.bg,
    '--pv-dk-panel': darkPalette.panel,
    '--pv-dk-raised': darkPalette.raised,
    '--pv-dk-line2': darkPalette.lineStrong,
    '--pv-dk-fg': darkPalette.text,
    '--pv-dk-muted': darkPalette.muted,
    '--pv-dk-faint': darkPalette.faint,
    '--pv-dk-red': TONES[scheme][DARK].red,
    '--pv-accent': tones.accent,
    '--pv-at': tones.accentText,
    '--pv-accent-ink': tones.accentInk,
    '--pv-blue': tones.blue,
    '--pv-purple': tones.purple,
    '--pv-orange': tones.orange,
    '--pv-aqua': tones.aqua,
    '--pv-green': tones.green,
    '--pv-red': tones.red,
    '--pv-yellow': tones.yellow,
    // Виды записей, как в прототипе
    '--pv-event': tones.blue,
    '--pv-task': tones.purple,
    '--pv-food': tones.orange,
    '--pv-sleep': tones.aqua,
    '--pv-workout': tones.green,
    '--pv-note': tones.yellow,
    '--pv-metric': tones.red,
    '--pv-bg': palette?.bg || 'var(--color-background-secondary)',
    '--pv-panel': palette?.panel || 'var(--color-background)',
    '--pv-raised': palette?.raised || 'var(--color-background-secondary-accent)',
    '--pv-hover': palette?.hover || 'var(--color-chat-hover)',
    '--pv-line': palette?.line || 'var(--color-borders)',
    '--pv-line2': palette?.lineStrong || 'var(--color-borders-input)',
    '--pv-fg': palette?.text || 'var(--color-text)',
    '--pv-muted': palette?.muted || 'var(--color-text-secondary)',
    '--pv-faint': palette?.faint || 'var(--color-gray)',
  };
}

function buildSemanticColors({
  error, warning, success, selection,
}: Semantic): Record<string, string> {
  return {
    '--color-error': error,
    '--color-error-shade': mix(error, '#000000', 0.08),
    '--color-error-rgb': toRgbChannels(error),
    '--color-warning': warning,
    '--color-text-green': success,
    '--color-text-green-rgb': toRgbChannels(success),
    '--color-selection-highlight': selection,
    '--color-selection-highlight-emoji': `rgba(${toRgbChannels(selection)}, 0.7)`,
  };
}

function toRgbChannels(hex: string) {
  return new Color(hex).to('srgb').coords.map((channel) => Math.round((channel ?? 0) * 255)).join(', ');
}
