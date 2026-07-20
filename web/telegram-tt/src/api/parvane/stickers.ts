// Стикеры: встроенный набор эмодзи-картинок (canvas → PNG). Рендерятся как
// document-медиа (getStickerMediaHash = document<id>); блобы регистрируются в
// media-кэше провайдера, чтобы downloadMedia отдавал их без облака. Отправка/
// приём — kind=sticker (реюз медиа-потока, alt-эмодзи в content).

import type { ApiSticker, ApiStickerSet } from '../types';

const SET_ID = 'parvane-builtin';
const SET_ACCESS = '0';
const SET_SHORT = 'ParvaneStickers';
const EMOJIS = ['😀', '😂', '😍', '👍', '🔥', '🎉', '❤️', '😎', '🙈', '🤔', '👋', '🚀'];
const SIZE = 256;

let cachedSet: { set: ApiStickerSet; blobs: Map<string, Blob> } | undefined;

function stickerId(index: number) {
  return `pvst${index}`;
}

async function renderEmoji(emoji: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.font = `${SIZE * 0.7}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, SIZE / 2, SIZE / 2 + SIZE * 0.05);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

function buildApiSticker(index: number, emoji: string): ApiSticker {
  return {
    mediaType: 'sticker',
    id: stickerId(index),
    stickerSetInfo: { id: SET_ID, accessHash: SET_ACCESS },
    emoji,
    isLottie: false,
    isVideo: false,
    width: SIZE,
    height: SIZE,
  };
}

// ── анимированные стикеры (webm) ─────────────────────────────────────────────
// canvas → MediaRecorder (vp9 с альфой, где поддержан). ApiSticker.isVideo —
// tt рендерит их штатным видео-путём

const ANIM_EMOJIS = ['🕺', '💃', '🎊'];
const ANIM_MS = 1200;
const ANIM_FPS = 30;

function animStickerId(index: number) {
  return `pvstA${index}`;
}

function pickStickerWebmMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

async function recordAnimatedSticker(emoji: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const mime = pickStickerWebmMime();
  const stream = canvas.captureStream(ANIM_FPS);
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const start = performance.now();
  let raf = 0;
  const render = () => {
    const t = ((performance.now() - start) % ANIM_MS) / ANIM_MS;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2 + Math.sin(t * Math.PI * 2) * SIZE * 0.08);
    ctx.rotate(Math.sin(t * Math.PI * 2) * 0.25);
    ctx.font = `${SIZE * 0.6}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 0, 0);
    ctx.restore();
    raf = requestAnimationFrame(render);
  };
  render();

  return new Promise((resolve) => {
    recorder.onstop = () => {
      cancelAnimationFrame(raf);
      resolve(new Blob(chunks, { type: mime }));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), ANIM_MS + 100);
  });
}

function buildApiAnimSticker(index: number, emoji: string): ApiSticker {
  return {
    mediaType: 'sticker',
    id: animStickerId(index),
    stickerSetInfo: { id: SET_ID, accessHash: SET_ACCESS },
    emoji,
    isLottie: false,
    isVideo: true,
    width: SIZE,
    height: SIZE,
  };
}

// Строит встроенный набор + карту id→Blob (для регистрации в media-кэше).
// mimes — video/webm для анимированных, остальные image/png
export async function buildBuiltinStickerSet() {
  if (cachedSet) return cachedSet;
  const stickers: ApiSticker[] = [];
  const blobs = new Map<string, Blob>();
  for (let i = 0; i < EMOJIS.length; i++) {
    stickers.push(buildApiSticker(i, EMOJIS[i]));
    blobs.set(stickerId(i), await renderEmoji(EMOJIS[i]));
  }
  for (let i = 0; i < ANIM_EMOJIS.length; i++) {
    stickers.push(buildApiAnimSticker(i, ANIM_EMOJIS[i]));
    blobs.set(animStickerId(i), await recordAnimatedSticker(ANIM_EMOJIS[i]));
  }
  const set: ApiStickerSet = {
    id: SET_ID,
    accessHash: SET_ACCESS,
    title: 'Parvane',
    shortName: SET_SHORT,
    count: stickers.length,
    installedDate: Math.floor(Date.now() / 1000),
    stickers,
  };
  cachedSet = { set, blobs };
  return cachedSet;
}

export function getStickerBlobMime(id: string) {
  return id.startsWith('pvstA') ? 'video/webm' : 'image/png';
}

export function getBuiltinSetId() {
  return SET_ID;
}

export function isBuiltinStickerId(id: string) {
  return id.startsWith('pvst');
}

// ── кастом-эмодзи (встроенный набор) ─────────────────────────────────────────
// Те же canvas-PNG, но isCustomEmoji: рендерятся инлайн в тексте по entity
// custom_emoji (documentId в data), медиа — тот же хэш document<id>

const EMOJI_SET_ID = 'parvane-emoji';
const EMOJI_SET_SHORT = 'ParvaneEmoji';
const CUSTOM_EMOJIS = ['🦋', '✨', '🌙', '⭐', '🍀', '🌈', '💎', '🐱', '🍕', '🎈', '🌸', '⚡'];
const EMOJI_SIZE = 128;

let cachedEmojiSet: { set: ApiStickerSet; blobs: Map<string, Blob> } | undefined;

function customEmojiId(index: number) {
  return `pvce${index}`;
}

function buildApiCustomEmoji(index: number, emoji: string): ApiSticker {
  return {
    mediaType: 'sticker',
    id: customEmojiId(index),
    stickerSetInfo: { id: EMOJI_SET_ID, accessHash: SET_ACCESS },
    emoji,
    isCustomEmoji: true,
    isLottie: false,
    isVideo: false,
    width: EMOJI_SIZE,
    height: EMOJI_SIZE,
  };
}

export async function buildBuiltinCustomEmojiSet() {
  if (cachedEmojiSet) return cachedEmojiSet;
  const stickers: ApiSticker[] = [];
  const blobs = new Map<string, Blob>();
  for (let i = 0; i < CUSTOM_EMOJIS.length; i++) {
    stickers.push(buildApiCustomEmoji(i, CUSTOM_EMOJIS[i]));
    blobs.set(customEmojiId(i), await renderEmoji(CUSTOM_EMOJIS[i]));
  }
  const set: ApiStickerSet = {
    id: EMOJI_SET_ID,
    accessHash: SET_ACCESS,
    title: 'Parvane Emoji',
    shortName: EMOJI_SET_SHORT,
    count: stickers.length,
    installedDate: Math.floor(Date.now() / 1000),
    isEmoji: true,
    stickers,
  };
  cachedEmojiSet = { set, blobs };
  return cachedEmojiSet;
}

export function isBuiltinCustomEmojiId(id: string) {
  return id.startsWith('pvce');
}
