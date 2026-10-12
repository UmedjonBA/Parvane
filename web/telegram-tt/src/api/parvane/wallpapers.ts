// Встроенные фоны чата. Галереи обоев Telegram у Parvane нет: фон — сочетание градиента и одного из десяти
// рисунков (`wallpaperCombo.ts`). Картинка сочетания рисуется на клиенте (canvas) только тогда, когда его
// выбрали, и дальше хранится как любой фон чата — байтами в шифрованном хранилище устройства.

import type { GradientPreset, PatternId } from './wallpaperCombo';

import { findGradient, getGradientInk, parseBackgroundSlug } from './wallpaperCombo';

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
export const PATTERN_URLS: Record<PatternId, string> = {
  mathematics: mathematicsPattern,
  programming: programmingPattern,
  cosmos: cosmosPattern,
  physics: physicsPattern,
  chemistry: chemistryPattern,
  biology: biologyPattern,
  electronics: electronicsPattern,
  algorithms: algorithmsPattern,
  flight: flightPattern,
  'science-mix': scienceMixPattern,
};
// Миниатюра своей картинки
const THUMB_SIZE = 192;
// Готовые картинки сочетаний в памяти: перебор образцов туда-обратно не рисует одно и то же заново
const RENDERED_LIMIT = 6;
// Картинка, загруженная пользователем (`uploadWallpaper`)
export const UPLOADED_SLUG_PREFIX = 'wp';

function drawGradient(size: number, preset: GradientPreset) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rad = (preset.angle * Math.PI) / 180;
  const x = Math.cos(rad) * size;
  const y = Math.sin(rad) * size;
  const gradient = ctx.createLinearGradient(size / 2 - x / 2, size / 2 - y / 2, size / 2 + x / 2, size / 2 + y / 2);
  const last = preset.colors.length - 1;
  preset.colors.forEach((color, index) => gradient.addColorStop(last ? index / last : 0, color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

const patternTilePromises = new Map<PatternId, Promise<HTMLCanvasElement | undefined>>();

// Рисунок узора растеризуется один раз; дальше им замощается любой фон
function loadPatternTile(pattern: PatternId) {
  let promise = patternTilePromises.get(pattern);
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
      image.src = PATTERN_URLS[pattern];
    });
    patternTilePromises.set(pattern, promise);
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
  const ink = getGradientInk(preset);
  tintedCtx.fillStyle = ink.color;
  tintedCtx.fillRect(0, 0, tinted.width, tinted.height);
  const ctx = canvas.getContext('2d')!;
  ctx.globalAlpha = ink.alpha;
  ctx.fillStyle = ctx.createPattern(tinted, 'repeat')!;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
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

const renderedBySlug = new Map<string, Promise<Blob | undefined>>();

async function renderBackground(slug: string) {
  const combination = parseBackgroundSlug(slug);
  const preset = findGradient(combination?.gradient);
  if (!combination || !preset || typeof document === 'undefined') return undefined;
  // Рисунок не загрузился — фон остаётся градиентом: пустой фон хуже
  const tile = await loadPatternTile(combination.pattern);
  const canvas = drawGradient(tile ? PATTERN_SIZE : SIZE, preset);
  if (tile) drawPattern(canvas, tile, preset);
  return canvasToBlob(canvas, 'image/jpeg', 0.9);
}

/**
 * Картинка встроенного фона по его идентификатору (сочетание либо прежняя жёсткая пара). Рисуется по
 * требованию: 180 сочетаний заранее не готовим.
 */
export function renderBackgroundBlob(slug: string): Promise<Blob | undefined> {
  let promise = renderedBySlug.get(slug);
  // Свежее — в конец: вытесняется давно не выбиравшееся
  renderedBySlug.delete(slug);
  if (!promise) {
    promise = renderBackground(slug).catch(() => undefined);
    void promise.then((blob) => {
      if (!blob && renderedBySlug.get(slug) === promise) renderedBySlug.delete(slug);
    });
  }
  renderedBySlug.set(slug, promise);
  if (renderedBySlug.size > RENDERED_LIMIT) renderedBySlug.delete(renderedBySlug.keys().next().value!);
  return promise;
}
