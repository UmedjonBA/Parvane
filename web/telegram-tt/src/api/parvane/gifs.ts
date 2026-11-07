// GIF: встроенные анимированные webm-клипы (canvas → MediaRecorder). Рендерятся
// как ApiVideo isGif; блобы регистрируются в media-кэше провайдера. Saved GIFs
// также наполняется отправленными/полученными kind=gif и персистится в
// IndexedDB (мета + ключи блоба — сам блоб дотягивается из cloud по file_id).

import { createStore, del, get, set } from 'idb-keyval';

import type { ApiVideo } from '../types';

import { SecureE2eStorage } from './secureStorage';

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

// Эмодзи и слова встроенных GIF — для локального поиска (`symbolSearch.ts`)
export const BUILTIN_GIF_TAGS: Record<string, { emoji: string; words: string[] }> = {
  'pvgif-spin': { emoji: '🚀', words: ['spin', 'rotate', 'вращение', 'кружится', 'крутится'] },
  'pvgif-pulse': { emoji: '❤️', words: ['pulse', 'heartbeat', 'пульс', 'бьется', 'сердцебиение'] },
};

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

// ── персист сохранённых GIF (на пользователя) ────────────────────────────────

const SAVED_STORAGE = createStore('parvane-gifs', 'saved');
const SAVED_LIMIT = 50;

export type SavedGifRecord = {
  id: string;
  width?: number;
  height?: number;
  duration: number;
  size: number;
  /** Имя файла — по нему ищет поиск GIF; у записей до 17 окт 2026 его нет. */
  fileName?: string;
  /** Тип файла: у записей до GIF-1 его нет — тогда webm. */
  mimeType?: string;
  /** sha256 содержимого, hex — ключ записи журнала `g:` (GIF-1). */
  sha256?: string;
  /** Сервер блоба (spec 028); пусто — свой. */
  blobDomain?: string;
  keyB64?: string;
  nonceB64?: string;
  capability?: string;
};

function savedKey(user: string) {
  return `gifs:${user}`;
}

// Ключи файлов сохранённых GIF — секрет (дают расшифровать блоб в cloud):
// в idb-keyval храним только метаданные, ключи — в SecureE2eStorage
const GIF_KEYS_RECORD = 'gifkeys';
type GifKeys = Record<string, { keyB64: string; nonceB64: string; capability?: string }>;

export async function loadSavedGifRecords(user: string): Promise<SavedGifRecord[]> {
  const records = (await get<SavedGifRecord[]>(savedKey(user), SAVED_STORAGE)) || [];
  const storage = await SecureE2eStorage.open(user).catch(() => undefined);
  if (!storage) return records.map(({ keyB64, nonceB64, capability, ...meta }) => meta);
  const keys = await storage.loadRecord<GifKeys>(GIF_KEYS_RECORD) || {};
  const legacy = records.filter((record) => record.keyB64 && record.nonceB64);
  if (legacy.length) {
    legacy.forEach((record) => {
      keys[record.id] = { keyB64: record.keyB64!, nonceB64: record.nonceB64! };
    });
    await storage.saveRecord(GIF_KEYS_RECORD, keys);
    await set(savedKey(user), records.map(({ keyB64, nonceB64, capability, ...meta }) => meta), SAVED_STORAGE);
  }
  return records.map((record) => ({ ...record, ...keys[record.id] }));
}

export async function storeSavedGifRecords(user: string, records: SavedGifRecord[]) {
  const limited = records.slice(0, SAVED_LIMIT);
  const storage = await SecureE2eStorage.open(user).catch(() => undefined);
  if (storage) {
    const keys: GifKeys = {};
    limited.forEach((record) => {
      if (record.keyB64 && record.nonceB64) {
        keys[record.id] = { keyB64: record.keyB64, nonceB64: record.nonceB64, capability: record.capability };
      }
    });
    await storage.saveRecord(GIF_KEYS_RECORD, keys);
  }
  const metadata = limited.map(({ keyB64, nonceB64, capability, ...meta }) => meta);
  if (metadata.length) await set(savedKey(user), metadata, SAVED_STORAGE);
  else await del(savedKey(user), SAVED_STORAGE);
}

export function buildApiVideoFromSavedRecord(record: SavedGifRecord): ApiVideo {
  return {
    mediaType: 'video',
    id: record.id,
    mimeType: record.mimeType || 'video/webm',
    duration: record.duration || 1,
    fileName: record.fileName || 'animation.webm',
    width: record.width || GIF_W,
    height: record.height || GIF_H,
    isGif: true,
    supportsStreaming: false,
    size: record.size,
    noSound: true,
  };
}

// ── «Загрузить GIF» из файла (GIF-1) ─────────────────────────────────────────
// Анимированный .gif элемент `<video>` не играет — кадры декодирует `ImageDecoder` (WebCodecs) и пишет в webm
// через холст и `MediaRecorder` в реальном времени

const GIF_CONVERT_MAX_SIDE = 512;
const GIF_CONVERT_MAX_MS = 30000;
const GIF_MIN_FRAME_MS = 20;
const GIF_DEFAULT_FRAME_MS = 100;
const MICROSECONDS_IN_MS = 1000;
const MS_IN_SECOND = 1000;

type GifImage = CanvasImageSource & {
  displayWidth: number; displayHeight: number; duration?: number; close: () => void;
};
type GifDecoder = {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  decode: (options: { frameIndex: number }) => Promise<{ image: GifImage }>;
  close: () => void;
};
type GifDecoderConstructor = new (init: { data: ArrayBuffer; type: string }) => GifDecoder;

export function canConvertGif() {
  return typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function'
    && typeof MediaRecorder !== 'undefined';
}

/** Анимированный .gif → webm и длительность в секундах (у записи `MediaRecorder` её нет в заголовке);
 * браузер без `ImageDecoder` или нечитаемый файл — undefined. */
export async function convertGifToWebm(file: Blob): Promise<{ blob: Blob; duration: number } | undefined> {
  if (!canConvertGif()) return undefined;
  const Decoder = (globalThis as unknown as { ImageDecoder: GifDecoderConstructor }).ImageDecoder;
  const decoder = new Decoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  try {
    await decoder.tracks.ready;
    const frameCount = decoder.tracks.selectedTrack?.frameCount || 1;
    const first = await decoder.decode({ frameIndex: 0 });
    const scale = Math.min(1, GIF_CONVERT_MAX_SIDE / Math.max(first.image.displayWidth, first.image.displayHeight));
    const canvas = document.createElement('canvas');
    // Кодеки VP8/VP9 требуют чётных сторон
    canvas.width = Math.max(2, Math.round((first.image.displayWidth * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((first.image.displayHeight * scale) / 2) * 2);
    const ctx = canvas.getContext('2d')!;
    const mime = pickWebmMime();
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    ctx.drawImage(first.image, 0, 0, canvas.width, canvas.height);
    recorder.start();
    let elapsedMs = 0;
    let frame = first;
    for (let index = 0; index < frameCount && elapsedMs < GIF_CONVERT_MAX_MS; index++) {
      if (index > 0) {
        frame = await decoder.decode({ frameIndex: index });
        ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
      }
      const frameMs = Math.max(GIF_MIN_FRAME_MS, frame.image.duration
        ? frame.image.duration / MICROSECONDS_IN_MS : GIF_DEFAULT_FRAME_MS);
      frame.image.close();
      elapsedMs += frameMs;
      await new Promise((resolve) => {
        setTimeout(resolve, frameMs);
      });
    }
    recorder.stop();
    await stopped;
    return chunks.length
      ? { blob: new Blob(chunks, { type: 'video/webm' }), duration: elapsedMs / MS_IN_SECOND } : undefined;
  } catch {
    return undefined;
  } finally {
    decoder.close();
  }
}
