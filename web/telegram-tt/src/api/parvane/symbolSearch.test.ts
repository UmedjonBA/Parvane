import { describe, expect, it } from 'vitest';

import type { ApiSticker, ApiStickerSet, ApiVideo } from '../types';

import {
  scoreEmoji, searchGifSources, searchStickerSets, setEmojiNameData, wordsOfFileName,
} from './symbolSearch';

function sticker(id: string, emoji: string, setId: string): ApiSticker {
  return {
    mediaType: 'sticker',
    id,
    emoji,
    stickerSetInfo: { id: setId, accessHash: '0' },
    isLottie: false,
    isVideo: false,
  };
}

function stickerSet(id: string, title: string, emojis: string[]): ApiStickerSet {
  const stickers = emojis.map((emoji, i) => sticker(`${id}-${i}`, emoji, id));
  return {
    id, accessHash: '0', title, shortName: title, count: stickers.length, stickers, installedDate: 1,
  };
}

function gif(id: string, fileName: string): ApiVideo {
  return {
    mediaType: 'video', id, fileName, mimeType: 'video/webm', duration: 1, size: 1, isGif: true,
  };
}

const BUILTIN = stickerSet('parvane-builtin', 'Parvane', ['😀', '😂', '❤️', '👍', '🚀']);
const OWN_PACK = stickerSet('pvpk-cats', 'Lazy Cats', ['🐱', '😴']);

describe('слово → эмодзи', () => {
  it('словарь EN и RU, по началу слова, ё = е', () => {
    expect(scoreEmoji('😂', 'смешно')).toBeGreaterThan(0);
    expect(scoreEmoji('😂', 'laugh')).toBeGreaterThan(0);
    expect(scoreEmoji('❤️', 'серд')).toBeGreaterThan(0);
    expect(scoreEmoji('😢', 'слёзы')).toBe(0);
    expect(scoreEmoji('😂', 'слёзы')).toBeGreaterThan(0);
    expect(scoreEmoji('🚀', 'кот')).toBe(0);
  });

  it('эмодзи в запросе совпадает без учёта вариантного селектора', () => {
    expect(scoreEmoji('❤️', '❤')).toBe(3);
    expect(scoreEmoji('❤', '❤️')).toBe(3);
  });

  it('английские имена из emoji-data дополняют словарь', () => {
    expect(scoreEmoji('🦄', 'unicorn')).toBe(0);
    // Формат emoji-data-ios: [категория, [[unified, [имена]]], …]
    setEmojiNameData([['nature', ['Animals']], [['1F984', ['unicorn_face']]]]);
    expect(scoreEmoji('🦄', 'unicorn')).toBe(2);
    expect(scoreEmoji('🦄', 'unic')).toBe(1);
  });
});

describe('searchStickerSets', () => {
  it('по эмодзи: найденные стикеры — обложки набора', () => {
    const [result, ...rest] = searchStickerSets('😂', [{ set: BUILTIN }, { set: OWN_PACK }]);
    expect(rest).toEqual([]);
    expect(result.id).toBe('parvane-builtin');
    expect(result.covers?.map((s) => s.emoji)).toEqual(['😂']);
  });

  it('по слову на русском и английском', () => {
    expect(searchStickerSets('ракета', [{ set: BUILTIN }, { set: OWN_PACK }]).map((s) => s.id))
      .toEqual(['parvane-builtin']);
    expect(searchStickerSets('sleep', [{ set: BUILTIN }, { set: OWN_PACK }]).map((s) => s.id))
      .toEqual(['pvpk-cats']);
    expect(searchStickerSets('кот', [{ set: BUILTIN }, { set: OWN_PACK }])[0].covers?.map((s) => s.emoji))
      .toEqual(['🐱']);
  });

  it('по названию набора — без обложек (не остаются от прошлого поиска)', () => {
    const [result] = searchStickerSets('lazy', [{ set: BUILTIN }, { set: { ...OWN_PACK, covers: [] } }]);
    expect(result.id).toBe('pvpk-cats');
    expect(result.covers).toEqual([]);
  });

  it('по имени файла стикера', () => {
    const fileWords = new Map([['pvpk-cats-1', ['sofa', 'nap']]]);
    const [result] = searchStickerSets('sofa', [{ set: BUILTIN }, { set: OWN_PACK, fileWords }]);
    expect(result.id).toBe('pvpk-cats');
    expect(result.covers?.map((s) => s.id)).toEqual(['pvpk-cats-1']);
  });

  it('ничего не найдено и пустой запрос — пустой ответ', () => {
    expect(searchStickerSets('зебрамобиль', [{ set: BUILTIN }, { set: OWN_PACK }])).toEqual([]);
    expect(searchStickerSets('  ', [{ set: BUILTIN }])).toEqual([]);
  });
});

describe('searchGifSources', () => {
  const spin = gif('pvgif-spin', 'pvgif-spin.webm');
  const pulse = gif('pvgif-pulse', 'pvgif-pulse.webm');
  const saved = gif('f1', 'dancing-penguin.mp4');
  const unnamed = gif('f2', 'animation.webm');
  const sources = [
    { gif: saved },
    { gif: unnamed },
    { gif: spin, emoji: '🚀', words: ['spin', 'вращение'] },
    { gif: pulse, emoji: '❤️', words: ['pulse', 'пульс'] },
  ];

  it('пустой запрос — все GIF', () => {
    expect(searchGifSources('', sources)).toEqual([saved, unnamed, spin, pulse]);
  });

  it('по эмодзи, слову → эмодзи, своим словам и имени файла', () => {
    expect(searchGifSources('🚀', sources)).toEqual([spin]);
    expect(searchGifSources('любовь', sources)).toEqual([pulse]);
    expect(searchGifSources('вращ', sources)).toEqual([spin]);
    expect(searchGifSources('penguin', sources)).toEqual([saved]);
  });

  it('служебное имя файла не ищется, ничего не найдено — пусто', () => {
    expect(searchGifSources('animation', sources)).toEqual([]);
    expect(wordsOfFileName('video-1a2b3c.mp4')).toEqual([]);
    expect(searchGifSources('зебра', sources)).toEqual([]);
  });
});
