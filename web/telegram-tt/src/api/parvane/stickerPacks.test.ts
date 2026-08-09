import { describe, expect, it } from 'vitest';

import {
  buildPvpkArchive,
  getSetIdForPackName,
  parsePvpkArchive,
  sanitizePackName,
} from './stickerPacks';

function bytesOf(...values: number[]) {
  return new Uint8Array(values).buffer;
}

describe('PVPK1 container', () => {
  it('round-trips files and keeps byte layout parsable', () => {
    const files = [
      { name: '01-1f600.png', data: bytesOf(1, 2, 3) },
      { name: 'dance.tgs', data: bytesOf(4, 5) },
      { name: 'clip.webm', data: bytesOf(6) },
    ];
    const archive = buildPvpkArchive(files)!;
    // Формат desktop: "PVPK1" + u32LE длина JSON-индекса
    expect(new TextDecoder().decode(archive.subarray(0, 5))).toBe('PVPK1');
    const indexLen = new DataView(archive.buffer).getUint32(5, true);
    const index = JSON.parse(new TextDecoder().decode(archive.subarray(9, 9 + indexLen)));
    expect(index).toEqual([
      { name: '01-1f600.png', size: 3 },
      { name: 'dance.tgs', size: 2 },
      { name: 'clip.webm', size: 1 },
    ]);

    const parsed = parsePvpkArchive(archive)!;
    expect(parsed.map(({ name }) => name)).toEqual(['01-1f600.png', 'dance.tgs', 'clip.webm']);
    expect(Array.from(new Uint8Array(parsed[0].data))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(parsed[2].data))).toEqual([6]);
  });

  it('skips unknown extensions on build and sanitizes names on parse', () => {
    expect(buildPvpkArchive([{ name: 'evil.exe', data: bytesOf(1) }])).toBeUndefined();

    const archive = buildPvpkArchive([{ name: 'ok.png', data: bytesOf(1, 2) }])!;
    // Подделываем index: имя с путём наружу и незнакомое расширение
    const indexLen = new DataView(archive.buffer).getUint32(5, true);
    const tampered = JSON.parse(new TextDecoder().decode(archive.subarray(9, 9 + indexLen)));
    tampered[0].name = '../../escape.png';
    const tamperedIndex = new TextEncoder().encode(JSON.stringify(tampered));
    const out = new Uint8Array(9 + tamperedIndex.length + 2);
    out.set(archive.subarray(0, 5), 0);
    new DataView(out.buffer).setUint32(5, tamperedIndex.length, true);
    out.set(tamperedIndex, 9);
    out.set([1, 2], 9 + tamperedIndex.length);
    const parsed = parsePvpkArchive(out)!;
    expect(parsed[0].name).toBe('escape.png');
  });

  it('rejects wrong magic and truncated payloads', () => {
    expect(parsePvpkArchive(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const archive = buildPvpkArchive([{ name: 'a.png', data: bytesOf(1, 2, 3, 4) }])!;
    archive[0] = 0x58;
    expect(parsePvpkArchive(archive)).toBeUndefined();
  });

  it('sanitizes pack names like desktop and derives stable set ids', () => {
    expect(sanitizePackName('  My Pack/..\\<x>!  ')).toBe('My Packx');
    expect(sanitizePackName('')).toBe('Pack');
    expect(getSetIdForPackName('My Pack')).toBe(getSetIdForPackName('My Pack'));
    expect(getSetIdForPackName('My Pack')).not.toBe(getSetIdForPackName('Other'));
    expect(getSetIdForPackName('My Pack').startsWith('pvpk-')).toBe(true);
  });
});
