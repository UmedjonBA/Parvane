import { describe, expect, it } from 'vitest';

import {
  buildSharedMeta, buildSharedMusicQuery, buildSharedText, buildShareNoteText, buildShareNoteTitle, findSharedMusicLink,
  getShareDestinations, isSharedAudio,
  parseSharedMeta, readShareForm,
} from './shareTarget';

const NOW = 1_800_000_000_000;

describe('«Поделиться в Parvane»', () => {
  it('форма: пустые поля и пустые файлы отбрасываются', () => {
    const form = new FormData();
    form.append('title', '  ');
    form.append('text', 'Посмотри');
    form.append('url', 'https://example.org/a');
    form.append('files', new File(['abc'], 'a.txt', { type: 'text/plain' }));
    form.append('files', new File([], 'empty.bin'));
    const shared = readShareForm(form);
    expect(shared.title).toBeUndefined();
    expect(shared.text).toBe('Посмотри');
    expect(shared.files.map((file) => file.name)).toEqual(['a.txt']);
  });

  it('сведения для кэша читаются обратно; чужие и устаревшие — нет', () => {
    const meta = buildSharedMeta({ text: 'привет', files: [new File(['x'], 'p.png', { type: 'image/png' })] }, NOW);
    expect(parseSharedMeta(JSON.parse(JSON.stringify(meta)), NOW + 1000)).toEqual({
      title: undefined, text: 'привет', url: undefined, files: [{ name: 'p.png', type: 'image/png', size: 1 }], at: NOW,
    });
    expect(parseSharedMeta(meta, NOW + 11 * 60 * 1000)).toBeUndefined();
    expect(parseSharedMeta({ at: NOW, files: [] }, NOW)).toBeUndefined();
    expect(parseSharedMeta('мусор', NOW)).toBeUndefined();
    expect(parseSharedMeta({ at: NOW, files: [{ name: 1 }], text: 'a' }, NOW)?.files).toEqual([]);
  });

  it('текст: ссылка, заголовок и текст без повторов', () => {
    expect(buildSharedText({ title: 'Статья', text: 'Читай https://e.org', url: 'https://e.org' }))
      .toBe('Статья\nЧитай https://e.org');
    expect(buildSharedText({ url: 'https://e.org', text: 'Смотри' })).toBe('https://e.org\nСмотри');
    expect(buildSharedText({ title: 'Одно', text: 'Одно' })).toBe('Одно');
  });

  it('куда: «Файлы» — только с файлами, модули — только включённые', () => {
    const allOn = () => true;
    const pdf = [{ name: 'report.pdf', type: 'application/pdf' }];
    const audio = [{ name: 'Harbor.FLAC', type: '' }];
    expect(getShareDestinations(pdf, allOn)).toEqual(['chat', 'files', 'note']);
    expect(getShareDestinations([], allOn)).toEqual(['chat', 'note']);
    expect(getShareDestinations(pdf, (id) => id !== 'files' && id !== 'notes')).toEqual(['chat']);
    // Аудио — в «Музыку», только когда сервер принимает свои файлы и модуль включён
    expect(getShareDestinations(audio, allOn, true)).toEqual(['chat', 'files', 'note', 'music']);
    expect(getShareDestinations(audio, allOn)).toEqual(['chat', 'files', 'note']);
    expect(getShareDestinations(pdf, allOn, true)).toEqual(['chat', 'files', 'note']);
    expect(getShareDestinations(audio, (id) => id !== 'music', true)).toEqual(['chat', 'files', 'note']);
    expect(isSharedAudio({ name: 'x', type: 'audio/mpeg' })).toBe(true);
  });

  it('заметка: название из заголовка, текста или имени файла; файлы вложениями', () => {
    expect(buildShareNoteTitle({ text: 'Список: молоко\nхлеб', fileNames: [] })).toBe('Список молоко');
    expect(buildShareNoteTitle({ fileNames: ['отчёт.pdf'] })).toBe('отчёт.pdf');
    expect(buildShareNoteText('Отчёт', 'текст', ['отчёт.pdf'])).toBe('# Отчёт\n\nтекст\n\n![[отчёт.pdf]]\n');
    expect(buildShareNoteText('Отчёт', '', [])).toBe('# Отчёт\n');
  });
});

describe('«Поделиться в Parvane» ссылкой на музыку (доска `MusicChat-04`)', () => {
  it('узнаёт сервис по адресу ссылки либо адресу в тексте', () => {
    expect(findSharedMusicLink({ url: 'https://open.spotify.com/track/abc' })?.kind).toBe('spotify');
    expect(findSharedMusicLink({ text: 'Послушай https://music.yandex.ru/album/1/track/2 ' })?.kind).toBe('yandex');
    expect(findSharedMusicLink({ url: 'https://youtu.be/xyz' })?.kind).toBe('youtube');
    expect(findSharedMusicLink({ url: 'https://lampa.bandcamp.com/track/utro' })?.kind).toBe('bandcamp');
    expect(findSharedMusicLink({ url: 'https://example.com/music' })).toBeUndefined();
    expect(findSharedMusicLink({ text: 'просто текст' })).toBeUndefined();
  });

  it('берёт для каталога название без адреса и хвоста сервиса', () => {
    expect(buildSharedMusicQuery({ text: 'Static Bloom — Kora Mesh https://open.spotify.com/track/abc' }))
      .toBe('Static Bloom — Kora Mesh');
    expect(buildSharedMusicQuery({ title: 'Утро — Lampa — Яндекс Музыка' })).toBe('Утро — Lampa');
  });
});
