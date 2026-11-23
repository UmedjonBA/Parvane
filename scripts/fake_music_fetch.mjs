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

// Ссылки каталога: исполнитель — `dz:a<номер>`, альбом — `dz:b<номер>` по месту имени в списке, трек — `dz:<100+место>`
function artistOut(name) {
  const names = [...new Set(CATALOG.map((track) => track.artist))];
  return { ref: `dz:a${names.indexOf(name)}`, name, picture: '', albums: 1 };
}

function albumOut(title) {
  const titles = [...new Set(CATALOG.map((track) => track.album))];
  const first = CATALOG.find((track) => track.album === title);
  return {
    ref: `dz:b${titles.indexOf(title)}`,
    title,
    artist: first?.artist || '',
    artist_ref: first ? artistOut(first.artist).ref : '',
    cover: '',
    year: 2025,
    record_type: 'album',
    tracks: CATALOG.filter((track) => track.album === title).length,
  };
}

function trackOut(track) {
  return {
    ...track,
    ref: `dz:${100 + CATALOG.indexOf(track)}`,
    album_ref: track.album ? albumOut(track.album).ref : '',
    cover: '',
    year: 2025,
  };
}

function refName(ref, names) {
  return names[Number(String(ref || '').replace(/^dz:[ab]/, ''))] || '';
}

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
    // Чип поиска: `artist:"…"`, `album:"…"`, `track:"…"` — по одному полю (как music-fetch)
    const field = query.match(/^(artist|album|track):"([^"]*)"$/);
    const tracks = field
      ? CATALOG.filter((track) => track[field[1] === 'track' ? 'title' : field[1]].toLowerCase().includes(field[2]))
      : CATALOG.filter((track) => `${track.artist} ${track.title}`.toLowerCase().includes(query));
    // Ссылка каталога — по месту в CATALOG (как `dz:<id>` у Deezer)
    return reply(res, 200, { tracks: tracks.map((track) => ({ ...track, ref: `dz:${100 + CATALOG.indexOf(track)}` })) });
  }
  // Каталог (поиск, исполнитель, альбом — доски `MusicSearch`, `XpMusic`): те же эталоны, исполнитель и альбом —
  // по именам из CATALOG
  if (url.pathname === '/catalog/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const tracks = CATALOG.filter((track) => `${track.artist} ${track.title} ${track.album}`.toLowerCase().includes(query));
    const artists = [...new Set(tracks.map((track) => track.artist))].map(artistOut);
    const albums = [...new Set(tracks.filter((track) => track.album).map((track) => track.album))].map(albumOut);
    return reply(res, 200, {
      artists, albums, tracks: tracks.map(trackOut), has_more: false, next: 0,
    });
  }
  if (url.pathname === '/catalog/artist') {
    const name = refName(url.searchParams.get('ref'), [...new Set(CATALOG.map((track) => track.artist))]);
    const own = CATALOG.filter((track) => track.artist === name);
    return reply(res, 200, {
      artist: artistOut(name),
      albums: [...new Set(own.filter((track) => track.album).map((track) => track.album))].map(albumOut),
      top: own.map(trackOut),
    });
  }
  if (url.pathname === '/catalog/album') {
    const title = refName(url.searchParams.get('ref'), [...new Set(CATALOG.map((track) => track.album))]);
    const tracks = CATALOG.filter((track) => track.album === title);
    return reply(res, 200, { album: albumOut(title), tracks: tracks.map(trackOut) });
  }
  // «Микс дня»: исполнители для выбора и похожие на выбранного
  if (url.pathname === '/catalog/artists') {
    return reply(res, 200, {
      artists: [
        { ref: 'dz:1', name: 'Kora Mesh', picture: '', albums: 2 },
        { ref: 'dz:2', name: 'Lampa', picture: '', albums: 1 },
      ],
    });
  }
  if (url.pathname === '/catalog/related') {
    return reply(res, 200, { artists: [{ ref: 'dz:3', name: 'Тихий порт', picture: '', albums: 1 }] });
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
