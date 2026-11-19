import { describe, expect, it } from 'vitest';

import { buildMusicPlaylistContent } from './musicPlaylistContent';

const encoder = new TextEncoder();

function track(index: number, title = `Трек ${index}`) {
  return {
    id: `t${index}`, title, artist: 'Тихий порт', durationSecs: 200,
  };
}

describe('PLAYLIST-1: содержимое плейлиста в чат', () => {
  it('треки по порядку и текст для клиентов без «Музыки»', () => {
    const content = buildMusicPlaylistContent({
      name: '  Дорога  ', server: 'music.example', tracks: [1, 2, 3, 4].map((n) => track(n)),
    });
    expect(content.kind).toBe('music_playlist');
    expect(content.name).toBe('Дорога');
    expect(content.track_server).toBe('music.example');
    expect(content.playlist_tracks!.map((item) => item.track_id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(content.text).toBe('🎵 Дорога: Тихий порт — Трек 1, Тихий порт — Трек 2, Тихий порт — Трек 3, …');
  });

  it('подписи урезаются по байтам, треков не больше 500 и сообщение умещается в операцию', () => {
    const long = 'ё'.repeat(1000);
    const content = buildMusicPlaylistContent({
      name: long, server: 'music.example', tracks: Array.from({ length: 700 }, (_, n) => track(n, long)),
    });
    expect(encoder.encode(content.name).length).toBeLessThanOrEqual(240);
    expect(encoder.encode(content.text).length).toBeLessThanOrEqual(600);
    const tracks = content.playlist_tracks!;
    expect(tracks.length).toBeLessThan(500);
    expect(tracks.every((item) => encoder.encode(item.title).length <= 400)).toBe(true);
    expect(encoder.encode(JSON.stringify(tracks)).length).toBeLessThan(200 * 1024);
    const short = buildMusicPlaylistContent({
      name: 'Много', server: 'music.example', tracks: Array.from({ length: 700 }, (_, n) => track(n)),
    });
    expect(short.playlist_tracks!.length).toBe(500);
  });
});
