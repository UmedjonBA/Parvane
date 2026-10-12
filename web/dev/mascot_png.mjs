// Запись листа кадров маскота в PNG (RGBA, без зависимостей) — общая для `gen_mascot*.mjs`.
// `frames` — кадры со стороной `grid`: строки ячеек, ячейка — цвет [r, g, b] или пусто (прозрачно)
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};

export function writeSpriteSheet(out, frames, grid) {
  const width = grid * frames.length;
  const raw = Buffer.alloc((width * 4 + 1) * grid);
  frames.forEach((g, frame) => {
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const c = g[y][x];
        if (!c) continue;
        const at = y * (width * 4 + 1) + 1 + (frame * grid + x) * 4;
        raw[at] = c[0]; raw[at + 1] = c[1]; raw[at + 2] = c[2]; raw[at + 3] = 255;
      }
    }
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(grid, 4);
  header[8] = 8; header[9] = 6;
  writeFileSync(out, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log(`${out}: ${width}×${grid}, кадров ${frames.length}`);
}
