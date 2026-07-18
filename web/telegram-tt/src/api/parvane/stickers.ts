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

// Строит встроенный набор + карту id→Blob (для регистрации в media-кэше)
export async function buildBuiltinStickerSet() {
  if (cachedSet) return cachedSet;
  const stickers: ApiSticker[] = [];
  const blobs = new Map<string, Blob>();
  for (let i = 0; i < EMOJIS.length; i++) {
    stickers.push(buildApiSticker(i, EMOJIS[i]));
    // eslint-disable-next-line no-await-in-loop
    blobs.set(stickerId(i), await renderEmoji(EMOJIS[i]));
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

export function getBuiltinSetId() {
  return SET_ID;
}

export function isBuiltinStickerId(id: string) {
  return id.startsWith('pvst');
}
