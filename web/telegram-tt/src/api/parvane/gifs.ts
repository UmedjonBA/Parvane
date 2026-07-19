// GIF: встроенные анимированные webm-клипы (canvas → MediaRecorder). Рендерятся
// как ApiVideo isGif; блобы регистрируются в media-кэше провайдера. Saved GIFs
// также наполняется отправленными/полученными kind=gif.

import type { ApiVideo } from '../types';

const GIF_W = 240;
const GIF_H = 240;
const REC_MS = 1200;

type GifDef = { id: string; draw: (ctx: CanvasRenderingContext2D, t: number) => void };

const BUILTIN: GifDef[] = [
  {
    id: 'pvgif-spin',
    draw: (ctx, t) => {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, GIF_W, GIF_H);
      ctx.save();
      ctx.translate(GIF_W / 2, GIF_H / 2);
      ctx.rotate(t * Math.PI * 2);
      ctx.font = '120px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🚀', 0, 0);
      ctx.restore();
    },
  },
  {
    id: 'pvgif-pulse',
    draw: (ctx, t) => {
      ctx.fillStyle = '#16213e';
      ctx.fillRect(0, 0, GIF_W, GIF_H);
      const scale = 0.8 + 0.3 * Math.sin(t * Math.PI * 2);
      ctx.save();
      ctx.translate(GIF_W / 2, GIF_H / 2);
      ctx.scale(scale, scale);
      ctx.font = '120px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('❤️', 0, 0);
      ctx.restore();
    },
  },
];

let cached: { gifs: ApiVideo[]; blobs: Map<string, Blob> } | undefined;

function pickWebmMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

async function recordGif(def: GifDef, mime: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = GIF_W;
  canvas.height = GIF_H;
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const start = performance.now();
  let raf = 0;
  const render = () => {
    const t = ((performance.now() - start) % REC_MS) / REC_MS;
    def.draw(ctx, t);
    raf = requestAnimationFrame(render);
  };
  render();

  return new Promise((resolve) => {
    recorder.onstop = () => {
      cancelAnimationFrame(raf);
      resolve(new Blob(chunks, { type: mime }));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), REC_MS + 100);
  });
}

function buildApiVideo(id: string, size: number, blobUrl: string): ApiVideo {
  return {
    mediaType: 'video',
    id,
    mimeType: 'video/webm',
    duration: REC_MS / 1000,
    fileName: `${id}.webm`,
    width: GIF_W,
    height: GIF_H,
    isGif: true,
    supportsStreaming: false,
    blobUrl,
    size,
    noSound: true,
  };
}

export async function buildBuiltinGifs() {
  if (cached) return cached;
  const mime = pickWebmMime();
  const gifs: ApiVideo[] = [];
  const blobs = new Map<string, Blob>();
  for (const def of BUILTIN) {
    const blob = await recordGif(def, mime);
    blobs.set(def.id, blob);
    gifs.push(buildApiVideo(def.id, blob.size, URL.createObjectURL(blob)));
  }
  cached = { gifs, blobs };
  return cached;
}
