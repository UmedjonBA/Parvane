// Фон чата — сочетание «цвет + рисунок» (решение пользователя 12 окт 2026): градиент и рисунок выбираются
// по отдельности. Здесь только данные и чистые функции (идентификатор сочетания, CSS градиента, цвет
// рисунка); холст и сами рисунки — в `wallpapers.ts`.

export const PATTERN_IDS = [
  'mathematics', 'programming', 'cosmos', 'physics', 'chemistry',
  'biology', 'electronics', 'algorithms', 'flight', 'science-mix',
] as const;

export type PatternId = typeof PATTERN_IDS[number];

export interface GradientPreset {
  id: string;
  colors: string[];
  // Угол в координатах холста: 0 — слева направо, 90 — сверху вниз
  angle: number;
  // Цвет и плотность рисунка поверх градиента
  ink: string;
  inkAlpha: number;
}

export interface BackgroundCombination {
  gradient: string;
  pattern: PatternId;
}

const LIGHT_INK = '#ffffff';
const LIGHT_INK_ALPHA = 0.22;
const DARK_INK_ALPHA = 0.3;

function dark(id: string, colors: string[], angle: number): GradientPreset {
  return {
    id, colors, angle, ink: LIGHT_INK, inkAlpha: LIGHT_INK_ALPHA,
  };
}

function light(id: string, colors: string[], angle: number, ink: string): GradientPreset {
  return {
    id, colors, angle, ink, inkAlpha: DARK_INK_ALPHA,
  };
}

// Порядок — порядок образцов на экране «Фон чата»
export const GRADIENTS: GradientPreset[] = [
  dark('night', ['#1b2338', '#101626', '#232f4d'], 135),
  dark('plum', ['#3a2350', '#1e142e', '#4d2a5c'], 150),
  dark('pine', ['#17382d', '#0d211b', '#1f4a3a'], 120),
  dark('coal', ['#24262b', '#15161a', '#32353c'], 140),
  light('meadow', ['#cfe6a8', '#9fd0a0', '#e3efc0'], 130, '#1f4d2a'),
  light('dawn', ['#f6d6c0', '#f0b6c2', '#fbe6cf'], 110, '#7a2f45'),
  light('lagoon', ['#bfe3f2', '#8fc7e6', '#d8f0f5'], 160, '#16506e'),
  light('lilac', ['#d9d0f5', '#b9a8ea', '#ece6fb'], 125, '#3f2f8a'),
  dark('dusk', ['#3b2a5a', '#1c1b33', '#0f1a2e'], 135),
  dark('forest', ['#1f4d3a', '#0f2f25', '#24613f'], 160),
  dark('ocean', ['#0f3d5c', '#0a2540', '#146b8a'], 120),
  dark('ember', ['#5a2a2a', '#2e1414', '#7a3b1f'], 145),
  dark('lavender', ['#7c6fcf', '#4a3f9a', '#a48ad6'], 110),
  light('mint', ['#7cd4b0', '#3f9a7a', '#b4e6cf'], 150, '#124a36'),
  light('sand', ['#d9c39a', '#b58f5a', '#f0dfc0'], 130, '#5a3d14'),
  light('sky', ['#8cc6f0', '#4a8fd6', '#cfe6fa'], 100, '#143f6e'),
  light('rose', ['#e2a0b8', '#b3607f', '#f4cfdc'], 125, '#6a1f3d'),
  dark('graphite', ['#3a3d45', '#1f2126', '#5a5f6a'], 140),
];

// Таблица переноса. До 12 окт 2026 фон был жёсткой парой «градиент + рисунок»: `builtin-pattern-<id>`
// (восемь фонов с узором) и `builtin-<id>` (десять прежних градиентов). Выбранный тогда фон остаётся тем же
const LEGACY_PATTERN_PREFIX = 'builtin-pattern-';
const LEGACY_PREFIX = 'builtin-';
const LEGACY_PATTERN_SLUGS: Record<string, PatternId> = {
  night: 'mathematics',
  plum: 'programming',
  pine: 'cosmos',
  coal: 'physics',
  meadow: 'biology',
  dawn: 'electronics',
  lagoon: 'algorithms',
  lilac: 'flight',
};
const LEGACY_SLUGS: Record<string, PatternId> = {
  dusk: 'chemistry',
  forest: 'biology',
  ocean: 'electronics',
  ember: 'algorithms',
  lavender: 'science-mix',
  mint: 'science-mix',
  sand: 'mathematics',
  sky: 'programming',
  rose: 'cosmos',
  graphite: 'flight',
};

// `combo-<градиент>_<рисунок>`: только знаки `\w` и `-` — идентификатор годится и как имя файла медиа-кэша
// (`wallpaper<slug>`); с `wp` (своя картинка) не начинается
export const COMBINATION_SLUG_PREFIX = 'combo-';
const COMBINATION_SEPARATOR = '_';

// Что подставить, пока выбрано только одно из двух: рисунок — тот же, что у фона по умолчанию
export const DEFAULT_PATTERN: PatternId = 'science-mix';
const DEFAULT_GRADIENT_BY_THEME = { light: 'lagoon', dark: 'night' } as const;

export function findGradient(id?: string) {
  return id ? GRADIENTS.find((preset) => preset.id === id) : undefined;
}

function isPatternId(id: string): id is PatternId {
  return (PATTERN_IDS as readonly string[]).includes(id);
}

export function buildCombinationSlug({ gradient, pattern }: BackgroundCombination) {
  return `${COMBINATION_SLUG_PREFIX}${gradient}${COMBINATION_SEPARATOR}${pattern}`;
}

/** Сочетание по идентификатору фона, в том числе прежнего вида. Чужое (своя картинка, цвет) — `undefined`. */
export function parseBackgroundSlug(slug?: string): BackgroundCombination | undefined {
  if (!slug) return undefined;
  if (slug.startsWith(COMBINATION_SLUG_PREFIX)) {
    const [gradient, pattern, ...rest] = slug.slice(COMBINATION_SLUG_PREFIX.length).split(COMBINATION_SEPARATOR);
    if (rest.length || !pattern || !findGradient(gradient) || !isPatternId(pattern)) return undefined;
    return { gradient, pattern };
  }
  if (slug.startsWith(LEGACY_PATTERN_PREFIX)) {
    const gradient = slug.slice(LEGACY_PATTERN_PREFIX.length);
    const pattern = Object.hasOwn(LEGACY_PATTERN_SLUGS, gradient) ? LEGACY_PATTERN_SLUGS[gradient] : undefined;
    return pattern ? { gradient, pattern } : undefined;
  }
  if (slug.startsWith(LEGACY_PREFIX)) {
    const gradient = slug.slice(LEGACY_PREFIX.length);
    const pattern = Object.hasOwn(LEGACY_SLUGS, gradient) ? LEGACY_SLUGS[gradient] : undefined;
    return pattern ? { gradient, pattern } : undefined;
  }
  return undefined;
}

export function getDefaultGradient(theme: 'light' | 'dark') {
  return DEFAULT_GRADIENT_BY_THEME[theme];
}

/**
 * Новое сочетание после выбора одного из двух. Второе берётся из текущего фона. если текущий фон —
 * не сочетание (умолчание, ровный цвет, своя картинка), подставляется градиент темы или рисунок по умолчанию.
 */
export function pickCombination(
  current: BackgroundCombination | undefined,
  change: Partial<BackgroundCombination>,
  theme: 'light' | 'dark',
): BackgroundCombination {
  return {
    gradient: change.gradient || current?.gradient || getDefaultGradient(theme),
    pattern: change.pattern || current?.pattern || DEFAULT_PATTERN,
  };
}

function parseHex(color: string) {
  const value = parseInt(color.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Средний цвет градиента: цвет фона под картинкой и основа цвета служебных сообщений. */
export function getGradientAverageColor(preset: GradientPreset) {
  const sum = [0, 0, 0];
  preset.colors.forEach((color) => parseHex(color).forEach((channel, index) => {
    sum[index] += channel;
  }));
  return `#${sum.map((channel) => Math.round(channel / preset.colors.length).toString(16).padStart(2, '0')).join('')}`;
}

function getRelativeLuminance(color: string) {
  const [r, g, b] = parseHex(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DARK_GRADIENT_LUMINANCE = 0.3;

export function isDarkGradient(preset: GradientPreset) {
  const total = preset.colors.reduce((sum, color) => sum + getRelativeLuminance(color), 0);
  return total / preset.colors.length < DARK_GRADIENT_LUMINANCE;
}

/** Цвет и плотность рисунка: на тёмном градиенте — светлый, на светлом — тёмный оттенок самого градиента. */
export function getGradientInk(preset: GradientPreset) {
  return { color: preset.ink, alpha: preset.inkAlpha };
}

/**
 * Тот же градиент средствами CSS — для образцов на экране выбора. Холст тянет градиент по отрезку длиной
 * в сторону квадрата, CSS — по более длинной линии до углов, поэтому точки цвета сжимаются к середине.
 */
export function gradientCss(preset: GradientPreset) {
  const rad = (preset.angle * Math.PI) / 180;
  const scale = 1 / (Math.abs(Math.sin(rad)) + Math.abs(Math.cos(rad)));
  const last = preset.colors.length - 1;
  const stops = preset.colors.map((color, index) => {
    const position = last ? index / last : 0;
    return `${color} ${Math.round((0.5 + (position - 0.5) * scale) * 1000) / 10}%`;
  });
  // Угол CSS отсчитывается от направления «вверх», угол холста — от направления «вправо»
  return `linear-gradient(${(preset.angle + 90) % 360}deg, ${stops.join(', ')})`;
}
