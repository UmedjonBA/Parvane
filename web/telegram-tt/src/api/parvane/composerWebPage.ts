// Предпросмотр ссылки над полем ввода (A2 ревью 7 ноя 2026): замена `messages.getWebPagePreview` Telegram.
// Метаданные — тот же шард превью, что и при отправке, но картинка не загружается в облако: она показывается из
// памяти (загрузка под секретом — только при самой отправке). Кнопка «убрать предпросмотр» tt ставит `noWebPage`,
// и отправка (`messages.ts sendMessage`) тогда превью не прикладывает

import type { ApiPhoto, ApiWebPageFull } from '../types';

export type LinkPreviewData = {
  url?: string;
  siteName?: string;
  title?: string;
  description?: string;
  image?: { blobUrl: string; width: number; height: number };
};

const DEFAULT_IMAGE_SIDE = 600;

function hashUrl(url: string) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = Math.imul(31, h) + url.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}

export function composerWebPageId(url: string) {
  return `wpc${hashUrl(url)}`;
}

export function buildComposerWebPage(url: string, preview?: LinkPreviewData): ApiWebPageFull {
  let displayUrl = url;
  try {
    displayUrl = new URL(url).hostname;
  } catch {
    // адрес как есть
  }
  const id = composerWebPageId(url);
  const image = preview?.image;
  const photo: ApiPhoto | undefined = image ? {
    mediaType: 'photo',
    id: `${id}-photo`,
    date: Math.floor(Date.now() / 1000),
    blobUrl: image.blobUrl,
    sizes: [
      { type: 'x', width: image.width || DEFAULT_IMAGE_SIDE, height: image.height || DEFAULT_IMAGE_SIDE },
      { type: 'y', width: image.width || DEFAULT_IMAGE_SIDE, height: image.height || DEFAULT_IMAGE_SIDE },
    ],
  } : undefined;
  return {
    mediaType: 'webpage',
    webpageType: 'full',
    id,
    // Адрес — из текста пользователя: сервер превью не подменяет ссылку карточки
    url,
    hash: 0,
    displayUrl,
    siteName: preview?.siteName || displayUrl,
    title: preview?.title,
    description: preview?.description,
    photo,
  };
}
