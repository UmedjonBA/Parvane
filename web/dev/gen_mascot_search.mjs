// Маскот Parvane с лупой — «ничего не найдено» вместо утки Telegram.
// Рисует лист кадров 24×24 (32 кадра в ряд, 4 с) и пишет PNG:
//   node web/dev/gen_mascot_search.mjs  →  web/telegram-tt/src/assets/parvane/mascot-ghost-search.png
// Тот же дух, что в `gen_mascot.mjs` (палитра, купол, подол волной, контур); к палитре добавлены стекло и янтарь.
// Кадры: 0 — стоит с лупой в руке; 1–9 — лупа у левого глаза, наклон влево; 10–17 — у правого, наклон вправо
// (глаз за стеклом большой, зрачок смотрит в сторону наклона); 18–19 — опускает лупу, лицо озадаченное;
// 20–28 — разводит руками три раза, над головой «?»; 29–31 — возвращается в исходную позу, моргает.
// Кадр 20 — неподвижная картинка для `prefers-reduced-motion` (см. `ParvaneMascot.module.scss`).
import { writeSpriteSheet } from './mascot_png.mjs';

const GRID = 24;
const FRAMES = 32;
const OUT = new URL('../telegram-tt/src/assets/parvane/mascot-ghost-search.png', import.meta.url).pathname;

const P = {
  body: [0xf6, 0xf2, 0xff], light: [0xff, 0xff, 0xff], shade: [0xd6, 0xcc, 0xf7], line: [0x5a, 0x48, 0xb8],
  eye: [0x2a, 0x21, 0x50], blush: [0xf2, 0xa1, 0xc4],
  glass: [0xc4, 0xe8, 0xff], amber: [0xf2, 0xa3, 0x3a],
};

const CX = 12;
const TOP = 6;
const HALF = 7;
const HEIGHT = 13;

// Позы. lean — наклон (сдвиг верха в пикселях), bob — подъём, hands — высота ручек [левая, правая],
// lens — центр лупы от (CX, top) и куда идёт ручка, look — куда смотрит глаз за стеклом
const REST = { lens: { x: 8, y: 3, handle: 'down' }, hands: [8, 8] };
const PASS = { lens: { x: 0, y: 10, handle: 'none' }, hands: [9, 9] };
const left = (lean, look, bob = 0) => ({
  lean, bob, lens: { x: -3, y: 6, handle: 'left', look }, hands: [10, 8],
});
const right = (lean, look, bob = 0) => ({
  lean, bob, lens: { x: 3, y: 6, handle: 'right', look }, hands: [8, 10],
});
const shrug = (isUp) => ({
  bob: isUp ? -1 : 0,
  lens: { x: 8, y: isUp ? -1 : 2, handle: 'down' },
  hands: isUp ? [4, 4] : [7, 7],
  face: 'puzzled',
  hasQuestion: true,
});

const POSES = [
  REST,
  PASS,
  left(-1, 0), left(-2, -1), left(-2, -1, -1), left(-2, -1, -1), left(-2, 0), left(-2, -1), left(-2, -1), left(-1, 0),
  PASS,
  right(1, 0), right(2, 1), right(2, 1, -1), right(2, 1, -1), right(2, 0), right(2, 1), right(1, 0),
  REST,
  { ...REST, face: 'puzzled' },
  shrug(true), shrug(true), shrug(false), shrug(true), shrug(true), shrug(false), shrug(true), shrug(true),
  shrug(false),
  { ...REST, face: 'puzzled' },
  { ...REST, face: 'blink' },
  REST,
];

const RING = [
  [-1, -3], [0, -3], [1, -3], [-2, -2], [2, -2], [-3, -1], [3, -1], [-3, 0], [3, 0], [-3, 1], [3, 1],
  [-2, 2], [2, 2], [-1, 3], [0, 3], [1, 3],
];
const isInsideLens = (dx, dy) => Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && Math.abs(dx) + Math.abs(dy) < 4;
const QUESTION = ['.#.', '#.#', '..#', '.#.', '...', '.#.'];

function drawFrame(frame) {
  const pose = POSES[frame];
  const {
    lean = 0, bob = 0, lens, hands, face = 'normal', hasQuestion,
  } = pose;
  let g = Array.from({ length: GRID }, () => new Array(GRID).fill(undefined));
  const put = (x, y, c) => { if (x >= 0 && x < GRID && y >= 0 && y < GRID) g[y][x] = c; };
  const rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
  const cx = CX;
  const top = TOP + bob;
  // Ручки
  rect(cx - 9, top + hands[0], 2, 2, P.body);
  rect(cx + 8, top + hands[1], 2, 2, P.shade);
  // Купол
  const radius = HALF + 0.5;
  for (let y = 0; y < HEIGHT; y++) {
    let w = HALF;
    if (y < radius) w = Math.floor(Math.sqrt(Math.max(0, radius * radius - (radius - y - 0.5) ** 2)));
    for (let x = -w; x <= w; x++) put(cx + x, top + y, x >= w - 1 ? P.shade : P.body);
  }
  // Блик слева сверху
  put(cx - 4, top + 2, P.light); put(cx - 5, top + 3, P.light); put(cx - 5, top + 4, P.light);
  // Подол волной
  for (let x = -HALF; x <= HALF; x++) {
    const len = ((x + HALF + frame) % 4) < 2 ? 2 : 1;
    for (let k = 0; k < len; k++) put(cx + x, top + HEIGHT + k, x >= HALF - 1 ? P.shade : P.body);
  }
  // Лицо
  for (const dx of [-3, 2]) {
    if (face === 'blink') rect(cx + dx, top + 6, 2, 1, P.eye);
    else if (face === 'puzzled') rect(cx + dx, top + 6, 2, 2, P.eye);
    else { rect(cx + dx, top + 5, 2, 3, P.eye); put(cx + dx, top + 5, P.light); }
  }
  put(cx - 5, top + 8, P.blush); put(cx + 5, top + 8, P.blush);
  if (face === 'puzzled') {
    // Брови домиком и уголки рта вниз
    put(cx - 4, top + 4, P.eye); put(cx - 3, top + 3, P.eye); put(cx + 2, top + 3, P.eye); put(cx + 3, top + 4, P.eye);
    put(cx - 2, top + 10, P.eye); put(cx - 1, top + 9, P.eye); put(cx, top + 9, P.eye); put(cx + 1, top + 10, P.eye);
  } else {
    put(cx - 1, top + 9, P.eye); put(cx, top + 9, P.eye);
  }
  // Наклон: верх уходит в сторону сильнее подола
  const shift = (y) => Math.round(lean * (1 - 0.5 * Math.min(1, Math.max(0, (y - top) / (HEIGHT + 2)))));
  if (lean) {
    g = g.map((row, y) => {
      const s = shift(y);
      return row.map((_, x) => row[x - s]);
    });
  }
  // Контур
  const out = g.map((row) => row.slice());
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (g[y][x]) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => g[y + dy]?.[x + dx])) out[y][x] = P.line;
    }
  }
  const over = (x, y, c) => { if (x >= 0 && x < GRID && y >= 0 && y < GRID) out[y][x] = c; };
  // Лупа поверх духа: ободок цвета контура, стекло, за стеклом — большой глаз
  const ly = top + lens.y;
  const lx = cx + lens.x + shift(ly);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) if (isInsideLens(dx, dy)) over(lx + dx, ly + dy, P.glass);
  }
  if (lens.look !== undefined) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (isInsideLens(lens.look + dx, dy)) over(lx + lens.look + dx, ly + dy, P.eye);
      }
    }
    over(lx + lens.look - 1, ly - 1, P.light);
  } else {
    over(lx - 1, ly - 1, P.light); over(lx, ly - 2, P.light);
  }
  for (const [dx, dy] of RING) over(lx + dx, ly + dy, P.line);
  if (lens.handle === 'left') { over(lx - 3, ly + 3, P.amber); over(lx - 4, ly + 4, P.amber); }
  if (lens.handle === 'right') { over(lx + 3, ly + 3, P.amber); over(lx + 4, ly + 4, P.amber); }
  if (lens.handle === 'down') over(lx, ly + 4, P.amber);
  // «?» над головой слева
  if (hasQuestion) {
    QUESTION.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') over(1 + i, j, P.amber); }));
  }
  return out;
}

writeSpriteSheet(OUT, POSES.map((_, frame) => drawFrame(frame)), GRID);
if (POSES.length !== FRAMES) throw new Error(`кадров ${POSES.length}, ожидалось ${FRAMES}`);
