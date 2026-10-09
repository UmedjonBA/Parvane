// Маскот Parvane — пиксельный дух, индикатор загрузки вместо кружка.
// Рисует лист кадров 24×24 (16 кадров в ряд) и пишет PNG:
//   node web/dev/gen_mascot.mjs  →  web/telegram-tt/src/assets/parvane/mascot-ghost.png
// Кадры: два круга танца (покачивание, ручки по очереди, подол волной), во втором — моргание.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const GRID = 24;
const FRAMES = 16;
const OUT = new URL('../telegram-tt/src/assets/parvane/mascot-ghost.png', import.meta.url).pathname;

const P = {
  body: [0xf6, 0xf2, 0xff], light: [0xff, 0xff, 0xff], shade: [0xd6, 0xcc, 0xf7], line: [0x5a, 0x48, 0xb8],
  eye: [0x2a, 0x21, 0x50], blush: [0xf2, 0xa1, 0xc4],
};
const BOB = [0, -1, -1, 0, 0, 1, 1, 0];
const SWAY = [-1, -1, 0, 1, 1, 1, 0, -1];

function drawFrame(frame) {
  const g = Array.from({ length: GRID }, () => new Array(GRID).fill(undefined));
  const put = (x, y, c) => { if (x >= 0 && x < GRID && y >= 0 && y < GRID) g[y][x] = c; };
  const rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
  const f = frame % 8;
  const cx = 12 + SWAY[f];
  const top = 4 + BOB[f];
  const half = 7;
  const height = 13;
  // Ручки: по очереди вверх
  rect(cx - 9, top + 8 + (f < 4 ? -2 : 0), 2, 2, P.body);
  rect(cx + 8, top + 8 + (f < 4 ? 0 : -2), 2, 2, P.shade);
  // Купол
  const radius = half + 0.5;
  for (let y = 0; y < height; y++) {
    let w = half;
    if (y < radius) w = Math.floor(Math.sqrt(Math.max(0, radius * radius - (radius - y - 0.5) ** 2)));
    for (let x = -w; x <= w; x++) put(cx + x, top + y, x >= w - 1 ? P.shade : P.body);
  }
  // Блик слева сверху
  put(cx - 4, top + 2, P.light); put(cx - 5, top + 3, P.light); put(cx - 5, top + 4, P.light);
  // Подол волной
  for (let x = -half; x <= half; x++) {
    const len = ((x + half + frame) % 4) < 2 ? 2 : 1;
    for (let k = 0; k < len; k++) put(cx + x, top + height + k, x >= half - 1 ? P.shade : P.body);
  }
  // Лицо: моргание один раз за два круга
  const isBlink = frame === 13;
  for (const dx of [-3, 2]) {
    if (isBlink) rect(cx + dx, top + 6, 2, 1, P.eye);
    else { rect(cx + dx, top + 5, 2, 3, P.eye); put(cx + dx, top + 5, P.light); }
  }
  put(cx - 5, top + 8, P.blush); put(cx + 5, top + 8, P.blush);
  put(cx - 1, top + 9, P.eye); put(cx, top + 9, P.eye);
  // Контур
  const out = g.map((row) => row.slice());
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (g[y][x]) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx])) out[y][x] = P.line;
    }
  }
  return out;
}

const width = GRID * FRAMES;
const raw = Buffer.alloc((width * 4 + 1) * GRID);
for (let frame = 0; frame < FRAMES; frame++) {
  const g = drawFrame(frame);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = g[y][x];
      if (!c) continue;
      const at = y * (width * 4 + 1) + 1 + (frame * GRID + x) * 4;
      raw[at] = c[0]; raw[at + 1] = c[1]; raw[at + 2] = c[2]; raw[at + 3] = 255;
    }
  }
}
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
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0); header.writeUInt32BE(GRID, 4);
header[8] = 8; header[9] = 6;
writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${OUT}: ${width}×${GRID}, кадров ${FRAMES}`);
