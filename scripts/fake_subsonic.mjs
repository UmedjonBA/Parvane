// Поддельный сервер музыкальной библиотеки для браузерных сценариев «Музыки» (spec 039): отвечает как
// Subsonic-сервер с внешней аутентификацией (Navidrome) — пользователь из заголовка `Remote-User`, незнакомого
// API не пускает (отказ 40), а страница `/app/` заводит. Треки — настоящие WAV (тишина), чтобы браузер их играл:
// первый короткий (переход на следующий трек виден за секунды), остальные длиннее. Поток отдаётся с Range.
// Запуск: node scripts/fake_subsonic.mjs <порт>
import http from 'node:http';

const PORT = Number(process.argv[2] || 19431);
const SAMPLE_RATE = 8000;

const ARTISTS = [
  { id: 'ar-1', name: 'Тихий порт' },
  { id: 'ar-2', name: 'Kora Mesh' },
];
const ALBUMS = [
  { id: 'al-1', name: 'Берег', artist: 'Тихий порт', artistId: 'ar-1', year: 2024 },
  { id: 'al-2', name: 'Static Bloom', artist: 'Kora Mesh', artistId: 'ar-2', year: 2025 },
];
const SONGS = [
  { id: 't1', title: 'Северный ветер', albumId: 'al-1', duration: 4 },
  { id: 't2', title: 'Harbor Lights', albumId: 'al-1', duration: 30 },
  { id: 't3', title: 'Соль', albumId: 'al-1', duration: 30 },
  { id: 't4', title: 'Glass Harbor', albumId: 'al-2', duration: 30 },
  { id: 't5', title: 'Первый снег', albumId: 'al-2', duration: 30 },
];

const users = new Set();
// Отметки «любимое»: `<пользователь> <трек>`
const starred = new Set();

function wav(seconds) {
  const samples = seconds * SAMPLE_RATE;
  const buffer = Buffer.alloc(44 + samples, 128);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  return buffer;
}

const AUDIO = new Map(SONGS.map((song) => [song.id, wav(song.duration)]));
// Обложка — однопиксельный PNG
const COVER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64',
);

function albumOf(id) {
  const album = ALBUMS.find((item) => item.id === id);
  const songs = SONGS.filter((song) => song.albumId === id);
  return {
    ...album, coverArt: id, songCount: songs.length, duration: songs.reduce((sum, song) => sum + song.duration, 0),
  };
}

function songOf(song, user) {
  const album = ALBUMS.find((item) => item.id === song.albumId);
  return {
    id: song.id,
    title: song.title,
    artist: album.artist,
    album: album.name,
    albumId: album.id,
    artistId: album.artistId,
    duration: song.duration,
    size: AUDIO.get(song.id).length,
    contentType: 'audio/wav',
    coverArt: album.id,
    track: SONGS.filter((item) => item.albumId === song.albumId).indexOf(song) + 1,
    year: album.year,
    bitRate: 64,
    ...(starred.has(`${user} ${song.id}`) ? { starred: '2026-11-16T00:00:00Z' } : {}),
  };
}

function reply(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } }));
}

function fail(res, code) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message: 'x' } },
  }));
}

const matches = (text, query) => !query || text.toLowerCase().includes(query);
const page = (items, offset, size) => items.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(size) || 20));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const user = String(req.headers['remote-user'] || '');
  if (!user) return fail(res, 40);
  if (url.pathname === '/app/') {
    users.add(user);
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html></html>');
  }
  if (!users.has(user)) return fail(res, 40);
  const q = url.searchParams;
  const id = q.get('id') || '';
  switch (url.pathname) {
    case '/rest/ping':
      return reply(res, {});
    case '/rest/search3': {
      const query = (q.get('query') || '').replace(/"/g, '').trim().toLowerCase();
      const songs = SONGS.filter((song) => {
        const album = ALBUMS.find((item) => item.id === song.albumId);
        return matches(`${song.title} ${album.name} ${album.artist}`, query);
      });
      return reply(res, {
        searchResult3: {
          song: page(songs, q.get('songOffset'), q.get('songCount')).map((song) => songOf(song, user)),
          album: page(ALBUMS.filter((album) => matches(`${album.name} ${album.artist}`, query)), q.get('albumOffset'), q.get('albumCount'))
            .map((album) => albumOf(album.id)),
          artist: page(ARTISTS.filter((artist) => matches(artist.name, query)), q.get('artistOffset'), q.get('artistCount'))
            .map((artist) => ({ ...artist, albumCount: ALBUMS.filter((album) => album.artistId === artist.id).length })),
        },
      });
    }
    case '/rest/getAlbumList2':
      return reply(res, { albumList2: { album: page(ALBUMS, q.get('offset'), q.get('size')).map((album) => albumOf(album.id)) } });
    case '/rest/getAlbum':
      if (!ALBUMS.some((album) => album.id === id)) return fail(res, 70);
      return reply(res, {
        album: { ...albumOf(id), song: SONGS.filter((song) => song.albumId === id).map((song) => songOf(song, user)) },
      });
    case '/rest/getArtist': {
      const artist = ARTISTS.find((item) => item.id === id);
      if (!artist) return fail(res, 70);
      const albums = ALBUMS.filter((album) => album.artistId === id).map((album) => albumOf(album.id));
      return reply(res, { artist: { ...artist, albumCount: albums.length, album: albums } });
    }
    case '/rest/getSong': {
      const song = SONGS.find((item) => item.id === id);
      return song ? reply(res, { song: songOf(song, user) }) : fail(res, 70);
    }
    case '/rest/star':
      starred.add(`${user} ${id}`);
      return reply(res, {});
    case '/rest/unstar':
      starred.delete(`${user} ${id}`);
      return reply(res, {});
    case '/rest/getStarred2': {
      const songs = SONGS.filter((song) => starred.has(`${user} ${song.id}`)).map((song) => songOf(song, user));
      // Пустой список у Subsonic — отсутствие поля
      return reply(res, { starred2: songs.length ? { song: songs } : {} });
    }
    case '/rest/stream': {
      const data = AUDIO.get(id);
      if (!data) return fail(res, 70);
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
      if (!range) {
        res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': data.length });
        return res.end(data);
      }
      const from = Number(range[1]);
      const to = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${from}-${to}/${data.length}`,
        'content-length': to - from + 1,
      });
      return res.end(data.subarray(from, to + 1));
    }
    case '/rest/getCoverArt':
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(COVER);
    default:
      return fail(res, 70);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake subsonic: http://127.0.0.1:${PORT}`);
});
