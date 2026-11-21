// Поддельный сервис скачивания для браузерных сценариев «Музыки» (spec 039, этап B): тот же контракт, что у
// `backend/infra/music-fetch/server.py`, без обращений в сеть. Каталог и кандидаты заданы здесь; «загрузка» пишет
// в папку библиотеки файл с именем из `dest`, который поддельная библиотека подхватит по `startScan`.
// Запуск: node scripts/fake_music_fetch.mjs <порт> <папка библиотеки>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.argv[2] || 19433);
const LIBRARY_DIR = process.argv[3];

// Эталоны каталога по словам запроса
const CATALOG = [
  { artist: 'Kora Mesh', title: 'Glass Harbor', album: 'Static Bloom', duration: 30, explicit: false },
  { artist: 'Lampa', title: 'Ночной автобус', album: 'Маршрут', duration: 30, explicit: null },
  { artist: 'Полдень', title: 'Громкая песня', album: 'Двор', duration: 30, explicit: true },
  { artist: 'Никто', title: 'Пустой трек', album: '', duration: 30, explicit: null },
  { artist: 'Lampa', title: 'Утро', album: 'Маршрут', duration: 30, explicit: null },
  // spec 041: качается медленно (ход в процентах, отмена) и сервис отказывает с причиной
  { artist: 'Тихий порт', title: 'Медленный берег', album: '', duration: 30, explicit: null },
  { artist: 'Тихий порт', title: 'Закрытый берег', album: '', duration: 30, explicit: null },
];

// Трек → источник → файлы. Чего нет в таблице — источник отвечает пустым списком
const CANDIDATES = {
  'Медленный берег': {
    soundcloud: [{ id: 'slow-1', title: 'Тихий порт - Медленный берег', uploader: 'Тихий порт', duration: 30, uploaded: '2025-02-01' }],
  },
  'Закрытый берег': {
    soundcloud: [{ id: 'refuse-1', title: 'Тихий порт - Закрытый берег', uploader: 'Тихий порт', duration: 30, uploaded: '2025-02-01' }],
  },
  'Ночной автобус': {
    soundcloud: [
      { id: 'cover-1', title: 'Lampa - Ночной автобус (cover)', uploader: 'кто-то', duration: 30, uploaded: '2025-02-01' },
      { id: 'exact-1', title: 'Lampa - Ночной автобус', uploader: 'Lampa', duration: 30, uploaded: '2025-02-01' },
    ],
  },
  Утро: {
    soundcloud: [{ id: 'morning-1', title: 'Lampa - Утро', uploader: 'Lampa', duration: 30, uploaded: '2025-03-01' }],
  },
  // Русский трек с ненормативной лексикой: обе копии новые, известной неотредактированной нет — файл выбирает
  // человек (сама качается только копия, про которую известно, что она не отредактирована)
  'Громкая песня': {
    youtube: [{ id: 'official-new', title: 'Полдень - Громкая песня', uploader: 'Полдень', duration: 30, uploaded: '2026-06-01' }],
    youtube_reupload: [
      { id: 'live-1', title: 'Полдень - Громкая песня (live)', uploader: 'архив', duration: 30, uploaded: '2026-06-10' },
    ],
  },
};

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Ход медленных загрузок (`dest` → байты) и снятые загрузки
const PROGRESS = new Map();
const CANCELLED = new Set();
const SLOW_BYTES = 8 * 1024 * 1024;
const SLOW_STEPS = 40;
const SLOW_STEP_MS = 500;

function readBody(req, handle) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => handle(JSON.parse(raw || '{}')));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/health') return reply(res, 200, { ok: true });
  if (url.pathname === '/catalog') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const tracks = CATALOG.filter((track) => `${track.artist} ${track.title}`.toLowerCase().includes(query));
    return reply(res, 200, { tracks });
  }
  if (url.pathname === '/candidates') {
    const found = CANDIDATES[url.searchParams.get('title')]?.[url.searchParams.get('source')] || [];
    return reply(res, 200, { candidates: found });
  }
  if (url.pathname === '/progress') {
    const done = PROGRESS.get(url.searchParams.get('dest'));
    return done === undefined ? reply(res, 404, {}) : reply(res, 200, { bytes_done: done, bytes_total: SLOW_BYTES });
  }
  if (url.pathname === '/cancel' && req.method === 'POST') {
    readBody(req, ({ dest }) => {
      CANCELLED.add(dest);
      reply(res, 200, {});
    });
    return undefined;
  }
  if (url.pathname === '/download' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const { dest, id } = JSON.parse(raw);
      if (id.startsWith('refuse')) {
        reply(res, 500, { reason: 'источник закрыт администратором' });
        return;
      }
      if (id.startsWith('slow')) {
        for (let step = 1; step <= SLOW_STEPS && !CANCELLED.has(dest); step++) {
          PROGRESS.set(dest, Math.round((SLOW_BYTES * step) / SLOW_STEPS));
          await new Promise((resolve) => { setTimeout(resolve, SLOW_STEP_MS); });
        }
        PROGRESS.delete(dest);
        if (CANCELLED.has(dest)) {
          reply(res, 500, { reason: 'отменено' });
          return;
        }
      }
      const relative = `${dest}.opus`;
      const full = path.join(LIBRARY_DIR, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.alloc(2048, 1));
      reply(res, 200, { path: relative, bytes: 2048, duration: 30 });
    });
    return undefined;
  }
  return reply(res, 404, {});
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake music fetch: http://127.0.0.1:${PORT}`);
});
