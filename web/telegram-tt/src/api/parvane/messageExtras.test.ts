import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiMessage } from '../types';
import type { V2Content } from './v2/contentMap';

import { decodeMessage, encodeMessage, initSync } from '../../lib/parvane-protocol/parvane_protocol';
import { contentOfWire, truncateUtf8, wireOfContent } from './v2/contentMap';
import {
  ALBUM_MAX_ITEMS,
  albumFields,
  createAlbumIds,
  createAlbumIndex,
  createAlbumSendQueue,
  quoteFromReplyInfo,
  replyInfoWithQuote,
  sendExtras,
  withMediaSpoiler,
} from './messageExtras';

// MEDIA-2 и QUOTE-1 (этап 4 ревью 7 ноя 2026): спойлер медиа, подпись над медиа, альбомы, цитата в ответе
const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');
const REPLY_UUID = '0190f0a0-0000-7000-8000-000000000001';
const PHOTO = {
  kind: 'photo', file_id: 'f1', mime: 'image/jpeg', width: 10, height: 10, file_key: 'AAAA', file_nonce: 'AAAA',
};

function fixedRandom(seed: number) {
  return (n: number) => new Uint8Array(n).fill(seed);
}

describe('MEDIA-2: поля провода', () => {
  it('спойлер, подпись над медиа и альбом проходят wire → v2 → wire', () => {
    const v2 = contentOfWire({
      ...PHOTO, caption: 'подпись', spoiler: true, invert_media: true, album_id: 'QUJD',
    });
    expect(v2.media?.spoiler).toBe(true);
    expect(v2.media?.album_id).toBe('QUJD');
    expect(v2.invert_media).toBe(true);
    const back = wireOfContent(v2);
    expect(back).toMatchObject({ spoiler: true, invert_media: true, album_id: 'QUJD' });
  });

  it('спойлер не ставится голосовому и файлу', () => {
    expect(contentOfWire({ kind: 'voice', file_id: 'v', spoiler: true }).media?.spoiler).toBeUndefined();
    expect(wireOfContent({ media: { kind: 'MEDIA_KIND_FILE', file_id: 'x', spoiler: true } })?.spoiler).toBeUndefined();
  });

  it('движок (WASM) знает поля: Content.invert_media, Media.spoiler, Media.album_id', () => {
    initSync({ module: readFileSync(WASM) });
    const v2 = contentOfWire({
      ...PHOTO, caption: 'x', spoiler: true, invert_media: true, album_id: btoa('0123456789abcdef'),
    });
    const decoded = JSON.parse(decodeMessage('parvane.msg.v2.Content', encodeMessage(
      'parvane.msg.v2.Content', JSON.stringify(v2),
    ))) as V2Content;
    expect(decoded.invert_media).toBe(true);
    expect(decoded.media?.spoiler).toBe(true);
    expect(decoded.media?.album_id).toBe(btoa('0123456789abcdef'));
  });

  it('sendExtras: опции окна отправки → поля, подпись над медиа только с подписью', () => {
    const albumIdOf = createAlbumIds(fixedRandom(7));
    const extras = sendExtras({
      attachment: { shouldSendAsSpoiler: true }, isInvertedMedia: true, groupedId: 'g1', text: 'подпись',
    }, albumIdOf);
    expect(extras.spoiler).toBe(true);
    expect(extras.invert_media).toBe(true);
    expect(extras.album_id).toBe(btoa(String.fromCharCode(...new Uint8Array(16).fill(7))));
    expect(sendExtras({ isInvertedMedia: true }, albumIdOf).invert_media).toBeUndefined();
  });

  it('один groupedId — одно album_id, разные — разные', () => {
    let seed = 1;
    const albumIdOf = createAlbumIds((n) => new Uint8Array(n).fill(seed++));
    expect(albumIdOf('a')).toBe(albumIdOf('a'));
    expect(albumIdOf('a')).not.toBe(albumIdOf('b'));
  });

  it('элементы альбома уходят подряд, даже если загрузки закончились в обратном порядке', async () => {
    const queue = createAlbumSendQueue();
    const sent: number[] = [];
    const turns = [0, 1, 2].map(() => queue.enter('album'));
    const delays = [30, 10, 0];
    await Promise.all(turns.map(async (turn, index) => {
      await new Promise((resolve) => {
        setTimeout(resolve, delays[index]);
      });
      await turn.ready;
      sent.push(index);
      turn.done();
    }));
    expect(sent).toEqual([0, 1, 2]);
  });

  it('спойлер у фото/видео содержимого tt, кружок без спойлера', () => {
    const photo = { photo: { mediaType: 'photo', id: 'p', sizes: [] } } as unknown as ApiMessage['content'];
    expect(withMediaSpoiler(photo, true).photo?.isSpoiler).toBe(true);
    expect(withMediaSpoiler(photo, undefined).photo?.isSpoiler).toBeUndefined();
    const round = { video: { mediaType: 'video', id: 'v', isRound: true } } as unknown as ApiMessage['content'];
    expect(withMediaSpoiler(round, true).video?.isSpoiler).toBeUndefined();
  });

  it('альбом у получателя: один автор и album_id — одна группа, не больше 10, другой автор — своя', () => {
    const index = createAlbumIndex();
    const ids = Array.from({ length: ALBUM_MAX_ITEMS + 2 }, (_, i) => 1000 + i);
    const grouped = ids.map((id) => index.groupedId('chat', 'alice@x', 'A', id));
    expect(new Set(grouped.slice(0, ALBUM_MAX_ITEMS)).size).toBe(1);
    expect(grouped[ALBUM_MAX_ITEMS]).not.toBe(grouped[0]);
    expect(grouped[ALBUM_MAX_ITEMS + 1]).toBe(grouped[ALBUM_MAX_ITEMS]);
    expect(index.groupedId('chat', 'bob@x', 'A', 2000)).not.toBe(grouped[0]);
    expect(index.groupedId('other', 'alice@x', 'A', 1000)).not.toBe(grouped[0]);
    // Повторная сборка того же сообщения — та же группа
    expect(index.groupedId('chat', 'alice@x', 'A', 1003)).toBe(grouped[3]);
  });

  it('фото — альбом, документ — группа документов без isInAlbum', () => {
    const photo = { photo: { mediaType: 'photo', id: 'p', sizes: [] } } as unknown as ApiMessage['content'];
    const doc = { document: { mediaType: 'document', id: 'd' } } as unknown as ApiMessage['content'];
    expect(albumFields(photo, 'g')).toEqual({ groupedId: 'g', isInAlbum: true });
    expect(albumFields(doc, 'g')).toEqual({ groupedId: 'g' });
    expect(albumFields(photo, undefined)).toEqual({});
  });
});

describe('QUOTE-1: цитата в ответе', () => {
  const replyInfo = {
    type: 'message' as const,
    replyToMsgId: 5,
    quoteText: { text: 'важная часть', entities: [{ type: 'MessageEntityBold' as const, offset: 0, length: 6 }] },
    quoteOffset: 7,
  };

  it('replyInfo tt → reply_quote → провод → replyInfo получателя', () => {
    const quote = quoteFromReplyInfo(replyInfo);
    expect(quote).toMatchObject({ text: 'важная часть', offset: 7 });
    expect(quote?.entities?.[0]).toMatchObject({ type: 'bold', offset: 0, length: 6 });
    const v2 = contentOfWire({ kind: 'text', text: 'ответ', reply_quote: quote }, REPLY_UUID);
    expect(v2.reply_quote?.text).toBe('важная часть');
    const back = wireOfContent(v2);
    expect(back?.reply_quote?.text).toBe('важная часть');
    const info = replyInfoWithQuote(42, back?.reply_quote);
    expect(info).toMatchObject({ replyToMsgId: 42, isQuote: true, quoteOffset: 7 });
    expect(info.quoteText?.text).toBe('важная часть');
  });

  it('без ответа цитата не уходит и не принимается', () => {
    const quote = quoteFromReplyInfo(replyInfo);
    expect(contentOfWire({ kind: 'text', text: 'x', reply_quote: quote }).reply_quote).toBeUndefined();
    expect(wireOfContent({ text: { text: 'x' }, reply_quote: { text: 'q' } })?.reply_quote).toBeUndefined();
    expect(quoteFromReplyInfo({ type: 'message', replyToMsgId: 5 })).toBeUndefined();
  });

  it('движок (WASM) знает Content.reply_quote', () => {
    initSync({ module: readFileSync(WASM) });
    const v2 = contentOfWire({ kind: 'text', text: 'ответ', reply_quote: { text: 'цитата', offset: 3 } }, REPLY_UUID);
    const decoded = JSON.parse(decodeMessage('parvane.msg.v2.Content', encodeMessage(
      'parvane.msg.v2.Content', JSON.stringify(v2),
    ))) as V2Content;
    expect(decoded.reply_quote).toMatchObject({ text: 'цитата', offset: 3 });
  });

  it('длинная цитата режется по байтам UTF-8 (max_len схемы), символ не разрывается, движок её принимает', () => {
    const utf8 = (text: string) => new TextEncoder().encode(text).length;
    const cyrillic = 'ж'.repeat(600);
    const v2 = contentOfWire({ kind: 'text', text: 'ответ', reply_quote: { text: cyrillic } }, REPLY_UUID);
    expect(utf8(v2.reply_quote!.text!)).toBe(1024);
    expect(v2.reply_quote!.text).toBe('ж'.repeat(512));
    // Эмодзи (4 байта, 2 единицы UTF-16) на границе не разрывается
    const emoji = truncateUtf8(`${'a'.repeat(1022)}😀`, 1024);
    expect(emoji).toBe('a'.repeat(1022));
    expect(truncateUtf8('abc', 1024)).toBe('abc');
    expect(utf8(wireOfContent({ text: { text: 'x' }, reply_to: { op_id: 'AA==' }, reply_quote: { text: cyrillic } })!
      .reply_quote!.text)).toBeLessThanOrEqual(1024);
    initSync({ module: readFileSync(WASM) });
    expect(() => encodeMessage('parvane.msg.v2.Content', JSON.stringify(v2))).not.toThrow();
  });
});
