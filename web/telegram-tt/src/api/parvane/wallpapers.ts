// Встроенные фоны чата. Галереи обоев Telegram у Parvane нет, а пустой
// экран «Фон чата» смущал; набор градиентов рисуем на клиенте (canvas) и
// кладём в медиа-кэш под хэшем `wallpaper<id>` — дальше WallpaperTile и
// useCustomBackground работают как с обычными обоями.

import type { ApiWallpaper } from '../types';

import algorithmsPattern from '../../assets/parvane/chat-patterns/algorithms.svg';
import biologyPattern from '../../assets/parvane/chat-patterns/biology.svg';
import chemistryPattern from '../../assets/parvane/chat-patterns/chemistry.svg';
import cosmosPattern from '../../assets/parvane/chat-patterns/cosmos.svg';
import electronicsPattern from '../../assets/parvane/chat-patterns/electronics.svg';
import flightPattern from '../../assets/parvane/chat-patterns/flight.svg';
import mathematicsPattern from '../../assets/parvane/chat-patterns/mathematics.svg';
import physicsPattern from '../../assets/parvane/chat-patterns/physics.svg';
import programmingPattern from '../../assets/parvane/chat-patterns/programming.svg';
import scienceMixPattern from '../../assets/parvane/chat-patterns/science-mix.svg';

const SIZE = 1024;
// Фон с узором растягивается на весь экран — рисуем крупнее, иначе рисунок расплывается
const PATTERN_SIZE = 2048;
const PATTERN_TILE_WIDTH = 480;
// Плитка рисунка — 400×800 (бесшовная), растеризуется чуть крупнее
const PATTERN_TILE_HEIGHT = PATTERN_TILE_WIDTH * 2;
// Рисунки пользователя (12 окт 2026): одноцветные контуры, перекрашиваются под фон
const PATTERNS = [
  mathematicsPattern, programmingPattern, cosmosPattern, physicsPattern, chemistryPattern,
  biologyPattern, electronicsPattern, algorithmsPattern, flightPattern, scienceMixPattern,
];
// Миниатюра плитки галереи: рисунок на ней должен быть виден, как в чате
const THUMB_SIZE = 192;
// Сторона вырезки готового фона под миниатюру: рисунок на плитке читается, а не превращается в шум
const THUMB_CROP = 300;
export const PATTERN_SLUG_PREFIX = 'builtin-pattern-';
// Картинка, загруженная пользователем (`uploadWallpaper`)
export const UPLOADED_SLUG_PREFIX = 'wp';

interface GradientPreset {
  id: string;
  colors: [string, string, string?];
  angle: number;
  // Цвет и плотность рисунка поверх градиента
  ink: string;
  inkAlpha: number;
  // Номер рисунка в `PATTERNS`
  pattern: number;
  // Прежний вид идентификатора (`builtin-<id>`): им названы фоны, выбранные до того, как узор получили все
  isLegacySlug?: boolean;
}

// Фоны чата: градиент и поверх него один из десяти рисунков (`PATTERNS`)
export const PATTERN_PRESETS: GradientPreset[] = [
  { id: 'night', colors: ['#1b2338', '#101626', '#232f4d'], angle: 135, ink: '#ffffff', inkAlpha: 0.22, pattern: 0 },
  { id: 'plum', colors: ['#3a2350', '#1e142e', '#4d2a5c'], angle: 150, ink: '#ffffff', inkAlpha: 0.22, pattern: 1 },
  { id: 'pine', colors: ['#17382d', '#0d211b', '#1f4a3a'], angle: 120, ink: '#ffffff', inkAlpha: 0.22, pattern: 2 },
  { id: 'coal', colors: ['#24262b', '#15161a', '#32353c'], angle: 140, ink: '#ffffff', inkAlpha: 0.22, pattern: 3 },
  { id: 'meadow', colors: ['#cfe6a8', '#9fd0a0', '#e3efc0'], angle: 130, ink: '#1f4d2a', inkAlpha: 0.3, pattern: 5 },
  { id: 'dawn', colors: ['#f6d6c0', '#f0b6c2', '#fbe6cf'], angle: 110, ink: '#7a2f45', inkAlpha: 0.3, pattern: 6 },
  { id: 'lagoon', colors: ['#bfe3f2', '#8fc7e6', '#d8f0f5'], angle: 160, ink: '#16506e', inkAlpha: 0.3, pattern: 7 },
  { id: 'lilac', colors: ['#d9d0f5', '#b9a8ea', '#ece6fb'], angle: 125, ink: '#3f2f8a', inkAlpha: 0.3, pattern: 8 },
];

// Фонов без узора нет (решение пользователя 12 окт 2026): прежние чистые градиенты получили тот же рисунок
const PRESETS: GradientPreset[] = [
  { id: 'dusk', colors: ['#3b2a5a', '#1c1b33', '#0f1a2e'], angle: 135, ink: '#ffffff', inkAlpha: 0.22, pattern: 4 },
  { id: 'forest', colors: ['#1f4d3a', '#0f2f25', '#24613f'], angle: 160, ink: '#ffffff', inkAlpha: 0.22, pattern: 5 },
  { id: 'ocean', colors: ['#0f3d5c', '#0a2540', '#146b8a'], angle: 120, ink: '#ffffff', inkAlpha: 0.22, pattern: 6 },
  { id: 'ember', colors: ['#5a2a2a', '#2e1414', '#7a3b1f'], angle: 145, ink: '#ffffff', inkAlpha: 0.22, pattern: 7 },
  { id: 'lavender', colors: ['#7c6fcf', '#4a3f9a', '#a48ad6'], angle: 110, ink: '#ffffff', inkAlpha: 0.22, pattern: 9 },
  { id: 'mint', colors: ['#7cd4b0', '#3f9a7a', '#b4e6cf'], angle: 150, ink: '#124a36', inkAlpha: 0.3, pattern: 9 },
  { id: 'sand', colors: ['#d9c39a', '#b58f5a', '#f0dfc0'], angle: 130, ink: '#5a3d14', inkAlpha: 0.3, pattern: 0 },
  { id: 'sky', colors: ['#8cc6f0', '#4a8fd6', '#cfe6fa'], angle: 100, ink: '#143f6e', inkAlpha: 0.3, pattern: 1 },
  { id: 'rose', colors: ['#e2a0b8', '#b3607f', '#f4cfdc'], angle: 125, ink: '#6a1f3d', inkAlpha: 0.3, pattern: 2 },
  { id: 'graphite', colors: ['#3a3d45', '#1f2126', '#5a5f6a'], angle: 140, ink: '#ffffff', inkAlpha: 0.22, pattern: 8 },
].map((preset) => ({ ...preset, isLegacySlug: true } as GradientPreset));

function drawGradient(size: number, preset: GradientPreset) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rad = (preset.angle * Math.PI) / 180;
  const x = Math.cos(rad) * size;
  const y = Math.sin(rad) * size;
  const gradient = ctx.createLinearGradient(size / 2 - x / 2, size / 2 - y / 2, size / 2 + x / 2, size / 2 + y / 2);
  const stops = preset.colors.filter(Boolean);
  stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

const patternTilePromises = new Map<number, Promise<HTMLCanvasElement | undefined>>();

// Рисунок узора растеризуется один раз; дальше им замощается любой фон
function loadPatternTile(index: number) {
  let promise = patternTilePromises.get(index);
  if (!promise) {
    promise = new Promise<HTMLCanvasElement | undefined>((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = PATTERN_TILE_WIDTH;
        canvas.height = PATTERN_TILE_HEIGHT;
        canvas.getContext('2d')!.drawImage(image, 0, 0, PATTERN_TILE_WIDTH, PATTERN_TILE_HEIGHT);
        resolve(canvas);
      };
      image.onerror = () => resolve(undefined);
      image.src = PATTERNS[index];
    });
    patternTilePromises.set(index, promise);
  }
  return promise;
}

function drawPattern(canvas: HTMLCanvasElement, tile: HTMLCanvasElement, preset: GradientPreset) {
  // Рисунок чёрный: перекрашиваем его в цвет фона через маску
  const tinted = document.createElement('canvas');
  tinted.width = tile.width;
  tinted.height = tile.height;
  const tintedCtx = tinted.getContext('2d')!;
  tintedCtx.drawImage(tile, 0, 0);
  tintedCtx.globalCompositeOperation = 'source-in';
  tintedCtx.fillStyle = preset.ink;
  tintedCtx.fillRect(0, 0, tinted.width, tinted.height);
  const ctx = canvas.getContext('2d')!;
  ctx.globalAlpha = preset.inkAlpha;
  ctx.fillStyle = ctx.createPattern(tinted, 'repeat')!;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
}

// Миниатюра — середина готового фона в том же масштабе рисунка, что и в чате
function drawThumbnail(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  const crop = Math.min(source.width, THUMB_CROP);
  const offset = (source.width - crop) / 2;
  canvas.getContext('2d')!.drawImage(source, offset, offset, crop, crop, 0, 0, THUMB_SIZE, THUMB_SIZE);
  return canvas;
}

/** Миниатюра картинки пользователя: по ней считается средний цвет фона. */
export async function buildThumbnailDataUri(blob: Blob) {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return undefined;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, THUMB_SIZE, THUMB_SIZE);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (err) {
    return undefined;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  return new Promise<Blob | undefined>((resolve) => {
    canvas.toBlob((blob) => resolve(blob || undefined), mimeType, quality);
  });
}

let builtinPromise: Promise<ApiWallpaper[]> | undefined;

export function buildBuiltinWallpapers(
  cacheBlob: (fileId: string, blob: Blob, mimeType: string) => void,
): Promise<ApiWallpaper[]> {
  if (builtinPromise) return builtinPromise;
  builtinPromise = (async () => {
    if (typeof document === 'undefined') return [];
    const result: ApiWallpaper[] = [];
    // Рисунок не загрузился — фоны остаются градиентами: пустая галерея хуже
    for (const preset of [...PATTERN_PRESETS, ...PRESETS]) {
      const tile = await loadPatternTile(preset.pattern);
      const id = preset.isLegacySlug ? `builtin-${preset.id}` : `${PATTERN_SLUG_PREFIX}${preset.id}`;
      const canvas = drawGradient(tile ? PATTERN_SIZE : SIZE, preset);
      if (tile) drawPattern(canvas, tile, preset);
      const full = await canvasToBlob(canvas, 'image/jpeg', 0.9);
      if (!full) continue;
      cacheBlob(id, full, 'image/jpeg');
      const thumb = drawThumbnail(canvas).toDataURL('image/jpeg', 0.8);
      result.push({
        slug: id,
        document: {
          mediaType: 'document',
          id,
          fileName: `${preset.id}.jpg`,
          mimeType: 'image/jpeg',
          size: full.size,
          thumbnail: { dataUri: thumb, width: THUMB_SIZE, height: THUMB_SIZE },
        },
      });
    }
    return result;
  })();
  return builtinPromise;
}
