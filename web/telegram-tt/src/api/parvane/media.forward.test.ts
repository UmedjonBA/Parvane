import { describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '../types';
import type { ParvaneStore } from './store';
import { ApiMessageEntityTypes } from '../types';

import { createMediaService } from './media';

// `util/browser/windowEnvironment.ts` (его тянут помощники tt) опрашивает на
// импорте matchMedia и CSS.supports, которых в jsdom нет
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.CSS = { ...(window.CSS || {}), supports: () => false };
});

vi.mock('./gateway', () => ({ getV2Bridge: () => undefined }));

const KEY = 'a2V5LWtleS1rZXkta2V5LWtleS1rZXkta2V5LWtleS0=';
const NONCE = 'bm9uY2Utbm9uY2U=';
const CAP = 'Y2FwLWNhcC1jYXAtY2FwLWNhcC1jYXAtY2FwLWNhcC0=';
const THUMB = 'dGh1bWI=';

function createService() {
  const service = createMediaService({
    getConnection: () => undefined,
    getStore: () => ({ self: 'kestrel@local' }) as unknown as ParvaneStore,
    getToken: () => 'token',
  });
  // Ключи и секрет скачивания приходят с принятым сообщением
  ['vid1', 'doc1', 'voice1', 'photo1'].forEach((fileId) => {
    service.rememberKeys({
      kind: 'file', file_id: fileId, file_key: KEY, file_nonce: NONCE, capability: CAP, thumbnail: THUMB,
    });
  });
  return service;
}

function message(content: ApiMessage['content']): ApiMessage {
  return {
    id: 1, chatId: '1', date: 1, isOutgoing: false, content,
  };
}

describe('пересылка медиа: messageToWireContent', () => {
  it('видео с подписью остаётся видео (раньше уходило одним текстом)', () => {
    const wire = createService().messageToWireContent(message({
      text: { text: 'смотри example.com', entities: [{ type: ApiMessageEntityTypes.Bold, offset: 0, length: 6 }] },
      video: {
        mediaType: 'video',
        id: 'vid1',
        mimeType: 'video/webm',
        duration: 3,
        fileName: 'clip-of-fox.webm',
        width: 320,
        height: 240,
        size: 1000,
      },
    }));
    expect(wire).toMatchObject({
      kind: 'video',
      file_id: 'vid1',
      filename: 'clip-of-fox.webm',
      mime: 'video/webm',
      caption: 'смотри example.com',
      file_key: KEY,
      file_nonce: NONCE,
      thumbnail: THUMB,
    });
    // Автоссылка (Url) на провод не уходит — получатель разметит сам
    expect(wire?.entities).toEqual([{ type: 'bold', offset: 0, length: 6 }]);
  });

  it('голосовое — voice с ключами; файл — с именем и подписью', () => {
    const service = createService();
    expect(service.messageToWireContent(message({
      voice: {
        mediaType: 'voice', id: 'voice1', duration: 2, size: 500, waveform: [1, 2, 3],
      },
    }))).toMatchObject({
      kind: 'voice', file_id: 'voice1', duration_secs: 2, waveform: [1, 2, 3], file_key: KEY,
    });
    expect(service.messageToWireContent(message({
      text: { text: 'отчёт' },
      document: {
        mediaType: 'document', id: 'doc1', fileName: 'notes-sample.pdf', mimeType: 'application/pdf', size: 42,
      },
    }))).toMatchObject({
      kind: 'file', file_id: 'doc1', filename: 'notes-sample.pdf', caption: 'отчёт', file_key: KEY,
    });
  });

  it('секрет скачивания исходного файла доступен для запасного пути пересылки', () => {
    expect(createService().getCapability('doc1')).toBe(CAP);
  });

  it('чистый текст пересылается текстом', () => {
    expect(createService().messageToWireContent(message({ text: { text: 'привет' } })))
      .toEqual({ kind: 'text', text: 'привет', entities: undefined });
  });
});
