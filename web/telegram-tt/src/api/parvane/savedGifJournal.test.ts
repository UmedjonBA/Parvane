import { describe, expect, it } from 'vitest';

import type { LocalStickerPack } from './localState';

import {
  buildGifFileName,
  buildGifJournalEntry,
  buildGifJournalKey,
  computeSha256Hex,
  getGifHashFromKey,
  getGifMimeFromName,
  parseGifJournalEntry,
  sortGifEntriesOldestFirst,
  splitJournalPacks,
  verifyGifBytes,
} from './savedGifJournal';

// sha256("abc")
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const ABC = new TextEncoder().encode('abc');

function pack(setId: string): LocalStickerPack {
  return { set_id: setId, ref: { file_id: `f-${setId}` } };
}

describe('GIF-1: ключ g:<sha256>', () => {
  it('ключ — sha256 содержимого в hex', async () => {
    const hashHex = await computeSha256Hex(ABC);
    expect(hashHex).toBe(ABC_SHA256);
    expect(buildGifJournalKey(hashHex)).toBe(`g:${ABC_SHA256}`);
    expect(getGifHashFromKey(`g:${ABC_SHA256}`)).toBe(ABC_SHA256);
  });

  it('ключи наборов и негодные ключи — не GIF', () => {
    expect(getGifHashFromKey(`h:${ABC_SHA256}`)).toBeUndefined();
    expect(getGifHashFromKey('n:mypack')).toBeUndefined();
    expect(getGifHashFromKey('g:xyz')).toBeUndefined();
    expect(getGifHashFromKey(`g:${ABC_SHA256}00`)).toBeUndefined();
  });
});

describe('GIF-1: записи журнала packs делятся на наборы и GIF', () => {
  it('g: не идут в установку наборов, удаления тоже делятся', () => {
    const gif = `g:${ABC_SHA256}`;
    const split = splitJournalPacks([pack('h:aa'), pack(gif), pack('n:b')], [gif, 'h:cc']);
    expect(split.packs.map((p) => p.set_id)).toEqual(['h:aa', 'n:b']);
    expect(split.gifs.map((p) => p.set_id)).toEqual([gif]);
    expect(split.removed).toEqual(['h:cc']);
    expect(split.removedGifs).toEqual([gif]);
  });
});

describe('GIF-1: проверка sha256 скачанного файла', () => {
  it('сходится только с тем же содержимым', async () => {
    expect(await verifyGifBytes(ABC, `g:${ABC_SHA256}`)).toBe(true);
    const other = new TextEncoder().encode('abd');
    expect(await verifyGifBytes(other, `g:${ABC_SHA256}`)).toBe(false);
    expect(await verifyGifBytes(ABC, 'h:whatever')).toBe(false);
  });
});

describe('GIF-1: запись журнала', () => {
  it('ссылка на файл, count 1, content_hash = сырой sha256; разбор обратно', () => {
    const entry = buildGifJournalEntry({
      hashHex: ABC_SHA256,
      fileId: 'file-1',
      name: 'cat',
      mimeType: 'video/mp4',
      key: 'k',
      nonce: 'n',
      capability: 'c',
      blobDomain: undefined,
      addedMs: 42,
    });
    expect(entry.set_id).toBe(`g:${ABC_SHA256}`);
    expect(entry.ref).toMatchObject({
      file_id: 'file-1', name: 'cat.mp4', count: 1, key: 'k', nonce: 'n', capability: 'c',
    });
    expect(entry.emoji).toBeUndefined();
    expect(entry.added_ms).toBe('42');
    expect(atob(entry.ref.content_hash!).length).toBe(32);
    const parsed = parseGifJournalEntry(entry)!;
    expect(parsed).toMatchObject({
      hashHex: ABC_SHA256, fileId: 'file-1', mimeType: 'video/mp4', addedMs: 42,
    });
  });

  it('content_hash, не совпадающий с ключом, — запись отвергнута', () => {
    const entry = buildGifJournalEntry({
      hashHex: ABC_SHA256, fileId: 'f', name: 'a.webm', mimeType: 'video/webm', addedMs: 1,
    });
    const forged = { ...entry, ref: { ...entry.ref, content_hash: btoa('x'.repeat(32)) } };
    expect(parseGifJournalEntry(forged)).toBeUndefined();
    expect(parseGifJournalEntry({ ...entry, set_id: 'g:bad' })).toBeUndefined();
  });

  it('тип — по расширению имени, порядок — от старых к новым', () => {
    expect(getGifMimeFromName('a.WEBM')).toBe('video/webm');
    expect(getGifMimeFromName('a.gif')).toBe('image/gif');
    expect(getGifMimeFromName('a')).toBe('video/mp4');
    expect(buildGifFileName('clip.gif', 'video/webm;codecs=vp9')).toBe('clip.webm');
    const refs = [3, 1, 2].map((addedMs) => ({
      hashHex: ABC_SHA256, fileId: String(addedMs), name: 'a.mp4', mimeType: 'video/mp4', addedMs,
    }));
    expect(sortGifEntriesOldestFirst(refs).map((ref) => ref.addedMs)).toEqual([1, 2, 3]);
  });
});
