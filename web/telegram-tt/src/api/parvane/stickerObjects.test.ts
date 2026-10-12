import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  beforeAll, describe, expect, it, vi,
} from 'vitest';

import type { ApiSticker } from '../types';
import type { StoredPack } from './stickerPacks';

import { getStickerMediaHash } from '../../global/helpers/messageMedia';
import { getMediaIdFromUrl } from '../../util/parvaneMediaIntegrity';
import { createMediaService, getMediaFileId } from './media';
import {
  buildApiCustomEmojiSetFromPack,
  buildApiStickerSetFromPack,
  buildLegacyEmojiDocId,
  buildParvaneSticker,
  getAliasEmojiSticker,
  getPackSetIdOfStickerId,
  resetPackRegistries,
} from './stickerPacks';
import { buildBuiltinCustomEmojiSet, buildBuiltinStickerSet } from './stickers';
import { ParvaneStore } from './store';

// `util/browser/windowEnvironment.ts` (его тянут помощники tt) опрашивает на
// импорте matchMedia и CSS.supports, которых в jsdom нет
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.CSS = { ...(window.CSS || {}), supports: () => false };
});

vi.mock('./gateway', () => ({ getV2Bridge: () => undefined }));
vi.mock('../gramjs', () => ({ callApi: () => Promise.resolve(undefined), cancelApiProgress: () => undefined }));

const BLOB_FORMAT = 0; // ApiMediaFormat.BlobUrl
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7]).buffer;
const TGS = new Uint8Array([31, 139, 8, 0, 9, 9]).buffer;
const WEBM = new Uint8Array([26, 69, 223, 163, 7]).buffer;

function buildPack(isEmoji?: boolean): StoredPack {
  return {
    name: 'Sorabi_7',
    isEmoji,
    files: [
      { name: '01-1f600.png', data: PNG },
      { name: '02-1f602.webp', data: PNG },
      { name: '03-1f60e.tgs', data: TGS },
      { name: '04-1f525.webm', data: WEBM },
    ],
  };
}

// Встроенные наборы рисуются на canvas и пишутся MediaRecorder'ом — в jsdom
// нет ни того, ни другого
function stubCanvas() {
  const context = new Proxy({}, { get: () => () => undefined });
  HTMLCanvasElement.prototype.getContext = (() => context) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
    callback(new Blob([PNG], { type: 'image/png' }));
  };
  HTMLCanvasElement.prototype.captureStream = (() => ({})) as unknown as HTMLCanvasElement['captureStream'];
  class FakeRecorder {
    static isTypeSupported() {
      return true;
    }

    ondataavailable?: (event: { data: Blob }) => void;

    onstop?: () => void;

    start() {
      this.ondataavailable?.({ data: new Blob([WEBM]) });
      queueMicrotask(() => this.onstop?.());
    }

    stop() {
      return this;
    }
  }
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
}

function createService(restoreLocalBlob?: (fileId: string) => Promise<void> | undefined) {
  return createMediaService({
    getConnection: () => undefined,
    getStore: () => new ParvaneStore('alice@local'),
    getToken: () => 'token',
    restoreLocalBlob,
  });
}

type Service = ReturnType<typeof createService>;

function register(service: Service, blobs: Map<string, { blob: Blob; mime: string } | Blob>) {
  blobs.forEach((entry, id) => {
    if (entry instanceof Blob) service.cacheBlobIfAbsent(id, entry, entry.type || 'image/png');
    else service.cacheBlobIfAbsent(id, entry.blob, entry.mime);
  });
}

async function download(service: Service, url: string) {
  const result = await service.downloadMedia({ url, mediaFormat: BLOB_FORMAT });
  return result && 'dataBlob' in result ? result : undefined;
}

// Картинка плитки окна набора и панели: статичный стикер рисуется миниатюрой
// (`?size=m`), анимированный — полным файлом; обе ссылки обязаны вести в блоб
async function expectPicture(service: Service, sticker: ApiSticker, source: Blob) {
  const full = await download(service, getStickerMediaHash(sticker, 'inline'));
  expect(full?.dataBlob, `полный файл ${sticker.id}`).toBe(source);
  const preview = await download(service, getStickerMediaHash(sticker, 'preview'));
  if (sticker.isLottie || sticker.isVideo) {
    // Кадра нет: прозрачная заглушка, а не серая
    const grey = await download(service, 'documentno-such-file?size=m');
    expect(preview?.mimeType).toBe('image/png');
    expect(preview?.dataBlob.size).not.toBe(grey?.dataBlob.size);
  } else {
    expect(preview?.dataBlob, `миниатюра ${sticker.id}`).toBe(source);
  }
}

function expectFree(sticker: ApiSticker) {
  expect(sticker.isFree, `isFree у ${sticker.id}`).toBe(true);
  expect(sticker.hasEffect, `hasEffect у ${sticker.id}`).toBeUndefined();
}

describe('объекты стикеров и кастом-эмодзи', () => {
  beforeAll(() => {
    stubCanvas();
    resetPackRegistries();
  });

  it('фабрика всегда отдаёт бесплатный стикер', () => {
    const sticker = buildParvaneSticker({
      id: 'x', stickerSetInfo: { id: 's', accessHash: '0' }, isLottie: false, isVideo: false,
    });
    expect(sticker).toMatchObject({ mediaType: 'sticker', isFree: true });
  });

  it('стикер-пак: все стикеры бесплатны, картинки отдаются по медиа-хэшам tt', async () => {
    const { set, blobs } = buildApiStickerSetFromPack(buildPack());
    const service = createService();
    register(service, blobs);
    expect(set.stickers).toHaveLength(4);
    for (const sticker of set.stickers!) {
      expectFree(sticker);
      expect(getPackSetIdOfStickerId(sticker.id)).toBe(set.id);
      await expectPicture(service, sticker, blobs.get(sticker.id)!.blob);
    }
  });

  it('эмодзи-пак: документы и их алиасы бесплатны, картинки отдаются', async () => {
    const pack = buildPack(true);
    const { set, blobs } = buildApiCustomEmojiSetFromPack(pack, 'Sorabi 7!', 'pvpk-1');
    const service = createService();
    register(service, blobs);
    expect(set.stickers).toHaveLength(4);
    for (const sticker of set.stickers!) {
      expectFree(sticker);
      expect(sticker.isCustomEmoji).toBe(true);
      await expectPicture(service, sticker, blobs.get(sticker.id)!.blob);
    }
    const alias = getAliasEmojiSticker(buildLegacyEmojiDocId('Sorabi 7!', pack.files[0].name));
    expect(alias).toBeDefined();
    expectFree(alias!);
    await expectPicture(service, alias!, blobs.get(alias!.id)!.blob);
  });

  it('встроенные наборы: стикеры и эмодзи бесплатны, картинки отдаются', async () => {
    const service = createService();
    for (const { set, blobs } of [await buildBuiltinStickerSet(), await buildBuiltinCustomEmojiSet()]) {
      register(service, blobs);
      expect(set.stickers!.length).toBeGreaterThan(0);
      for (const sticker of set.stickers!) {
        expectFree(sticker);
        const full = await download(service, getStickerMediaHash(sticker, 'inline'));
        expect(full?.dataBlob).toBe(blobs.get(sticker.id));
      }
    }
  });

  it('вытесненная из кэша картинка стикера пака возвращается из набора, а не из облака', async () => {
    const { set, blobs } = buildApiStickerSetFromPack(buildPack());
    const asked: string[] = [];
    const service: Service = createService((fileId) => {
      asked.push(fileId);
      if (!getPackSetIdOfStickerId(fileId)) return undefined;
      register(service, blobs);
      return Promise.resolve();
    });
    const sticker = set.stickers![0];
    const preview = await download(service, getStickerMediaHash(sticker, 'preview'));
    expect(preview?.dataBlob).toBe(blobs.get(sticker.id)!.blob);
    const second = set.stickers![1];
    const full = await download(service, getStickerMediaHash(second, 'inline'));
    expect(full?.dataBlob).toBe(blobs.get(second.id)!.blob);
    // Второй уже в кэше: набор возвращён целиком первым запросом
    expect(asked).toEqual([sticker.id]);
  });

  it('id стикера пака разбирается из хэша и в слое API, и в util', () => {
    const { set } = buildApiStickerSetFromPack(buildPack());
    const { id } = set.stickers![0];
    expect(id).toContain(':');
    for (const target of ['inline', 'preview', 'micro', 'download'] as const) {
      const hash = getStickerMediaHash(set.stickers![0], target);
      expect(getMediaFileId(hash), hash).toBe(id);
      expect(getMediaIdFromUrl(hash), hash).toBe(id);
    }
    expect(getMediaIdFromUrl(`https://host/progressive/document${id}`)).toBe(id);
  });

  // Сторож: новый сборщик стикера обязан идти через `buildParvaneSticker`,
  // иначе стикер снова окажется «премиальным» (звезда, замок)
  it('ApiSticker собирается только фабрикой', () => {
    const root = path.join(process.cwd(), 'src/api/parvane');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const count = readFileSync(full, 'utf8').split('mediaType: \'sticker\'').length - 1;
          const allowed = path.relative(root, full) === 'stickerPacks.ts' ? 1 : 0;
          if (count !== allowed) offenders.push(`${path.relative(root, full)}: ${count}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
