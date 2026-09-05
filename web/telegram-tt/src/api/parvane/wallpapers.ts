// Встроенные фоны чата. Галереи обоев Telegram у Parvane нет, а пустой
// экран «Фон чата» смущал; набор градиентов рисуем на клиенте (canvas) и
// кладём в медиа-кэш под хэшем `wallpaper<id>` — дальше WallpaperTile и
// useCustomBackground работают как с обычными обоями.

import type { ApiWallpaper } from '../types';

const SIZE = 1024;
const THUMB_SIZE = 32;

interface GradientPreset {
  id: string;
  colors: [string, string, string?];
  angle: number;
}

const PRESETS: GradientPreset[] = [
  { id: 'dusk', colors: ['#3b2a5a', '#1c1b33', '#0f1a2e'], angle: 135 },
  { id: 'forest', colors: ['#1f4d3a', '#0f2f25', '#24613f'], angle: 160 },
  { id: 'ocean', colors: ['#0f3d5c', '#0a2540', '#146b8a'], angle: 120 },
  { id: 'ember', colors: ['#5a2a2a', '#2e1414', '#7a3b1f'], angle: 145 },
  { id: 'lavender', colors: ['#7c6fcf', '#4a3f9a', '#a48ad6'], angle: 110 },
  { id: 'mint', colors: ['#7cd4b0', '#3f9a7a', '#b4e6cf'], angle: 150 },
  { id: 'sand', colors: ['#d9c39a', '#b58f5a', '#f0dfc0'], angle: 130 },
  { id: 'sky', colors: ['#8cc6f0', '#4a8fd6', '#cfe6fa'], angle: 100 },
  { id: 'rose', colors: ['#e2a0b8', '#b3607f', '#f4cfdc'], angle: 125 },
  { id: 'graphite', colors: ['#3a3d45', '#1f2126', '#5a5f6a'], angle: 140 },
];

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
    for (const preset of PRESETS) {
      const id = `builtin-${preset.id}`;
      const full = await canvasToBlob(drawGradient(SIZE, preset), 'image/jpeg', 0.9);
      if (!full) continue;
      cacheBlob(id, full, 'image/jpeg');
      const thumb = drawGradient(THUMB_SIZE, preset).toDataURL('image/jpeg', 0.7);
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
