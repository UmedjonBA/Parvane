import { describe, expect, it } from 'vitest';

import { bytesToBase64 } from './v2/base64';
import { v2ToWire, wireToV2 } from './v2/contentMap';
import {
  encodeThumbnail, fitThumbSize, THUMB_MAX_BYTES, THUMB_MAX_SIDE, thumbBytes, thumbnailFromWire,
} from './mediaThumb';

describe('message media thumbnails (perf A10)', () => {
  it('fits the thumbnail into 320 px keeping the aspect ratio and never upscales', () => {
    expect(fitThumbSize(1600, 1200)).toEqual({ width: 320, height: 240 });
    expect(fitThumbSize(300, 900)).toEqual({ width: 107, height: 320 });
    expect(fitThumbSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(THUMB_MAX_SIDE).toBe(320);
  });

  it('builds ApiThumbnail from wire content and ignores content without a thumbnail', () => {
    const jpeg = bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(thumbnailFromWire({ thumbnail: jpeg, width: 4000, height: 3000 })).toEqual({
      dataUri: `data:image/jpeg;base64,${jpeg}`, width: 320, height: 240,
    });
    expect(thumbnailFromWire({ width: 4000, height: 3000 })).toBeUndefined();
    expect(thumbBytes(jpeg)?.length).toBe(7);
    // Больше предела схемы — не миниатюра
    expect(thumbBytes(bytesToBase64(new Uint8Array(THUMB_MAX_BYTES + 1)))).toBeUndefined();
    expect(thumbBytes('%%%')).toBeUndefined();
  });

  it('carries the thumbnail through the v2 content mapping both ways', () => {
    const thumbnail = bytesToBase64(new Uint8Array([0xff, 0xd8, 9, 9, 9]));
    const wire = {
      kind: 'photo', file_id: 'f1', mime: 'image/jpeg', width: 640, height: 480, file_key: 'k', file_nonce: 'n',
      capability: 'c', thumbnail,
    };
    const v2 = wireToV2(wire);
    expect(v2.media?.thumbnail).toBe(thumbnail);
    expect(v2ToWire(v2)?.thumbnail).toBe(thumbnail);
    // Без миниатюры поле не появляется
    expect(v2ToWire(wireToV2({ ...wire, thumbnail: undefined }))).not.toHaveProperty('thumbnail');
  });

  it('returns undefined where the platform cannot draw a frame (jsdom)', async () => {
    expect(await encodeThumbnail(new Blob([new Uint8Array(10)], { type: 'image/png' }))).toBeUndefined();
    expect(await encodeThumbnail(new Blob([]))).toBeUndefined();
  });
});
