import { describe, expect, it } from 'vitest';

import { createBlobSink } from '../api/parvane/cloudBlobs';
import {
  archiveFileName, canZip, crc32, createZipWriter,
} from './zip';

// Читатель архива по оглавлению — как распаковщики: конец архива → оглавление → заголовок файла → данные
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: { name: string; data: Uint8Array; crc: number; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    // Дескриптор после данных повторяет CRC и размер
    expect(view.getUint32(dataStart + size, true)).toBe(0x08074b50);
    expect(view.getUint32(dataStart + size + 4, true)).toBe(crc);
    out.push({
      name, data, crc, flags,
    });
    at += 46 + nameLength;
  }
  return out;
}

describe('ZIP «Скачать всё»', () => {
  it('CRC-32 по стандартному вектору', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const parts = new TextEncoder().encode('Parvane');
    expect(crc32(parts.subarray(3), crc32(parts.subarray(0, 3)))).toBe(crc32(parts));
  });

  it('файлы потоком кусками, папка, кириллица в именах', async () => {
    const { sink, getBlob } = createBlobSink('application/zip');
    const zip = createZipWriter(sink, new Date(2026, 9, 15, 12, 30, 10));
    const first = await zip.file('Отчёты/итог.txt');
    await first.write(new TextEncoder().encode('при'));
    await first.write(new TextEncoder().encode('вет'));
    await first.close();
    await zip.addDir('Отчёты/Пустая');
    const empty = await zip.file('ноль.bin');
    await empty.close();
    await zip.finish();
    const entries = readZip(new Uint8Array(await getBlob()!.arrayBuffer()));
    expect(entries.map(({ name }) => name)).toEqual(['Отчёты/итог.txt', 'Отчёты/Пустая/', 'ноль.bin']);
    expect(new TextDecoder().decode(entries[0].data)).toBe('привет');
    expect(entries[0].crc).toBe(crc32(new TextEncoder().encode('привет')));
    expect(entries[2].data.length).toBe(0);
    expect(entries.every(({ flags }) => flags === 0x0808)).toBe(true);
  });

  it('следующий файл не начинается, пока прежний не закрыт', async () => {
    const zip = createZipWriter(createBlobSink('application/zip').sink);
    await zip.file('a');
    await expect(zip.file('b')).rejects.toThrow();
  });

  it('предел без ZIP64: 4 ГиБ и 65 535 элементов', () => {
    expect(canZip([{ name: 'a', size: 1024 }])).toBe(true);
    expect(canZip([{ name: 'a', size: 2 ** 32 }])).toBe(false);
    expect(canZip(Array.from({ length: 70000 }, (_, i) => ({ name: String(i), size: 0 })))).toBe(false);
  });
});

describe('archiveFileName', () => {
  it('название ссылки — имя архива, кириллица и пробелы остаются', () => {
    expect(archiveFileName('Отчёты за квартал')).toBe('Отчёты за квартал.zip');
  });

  it('знаки, запрещённые в именах файлов, и управляющие — пробелом', () => {
    expect(archiveFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j.zip');
    expect(archiveFileName('строка\nвторая\tтретья')).toBe('строка вторая третья.zip');
  });

  it('без второго .zip, без точек и пробелов по краям, пустое — parvane.zip', () => {
    expect(archiveFileName('Архив.ZIP')).toBe('Архив.zip');
    expect(archiveFileName('  ..скрытая.. ')).toBe('скрытая.zip');
    expect(archiveFileName('')).toBe('parvane.zip');
    expect(archiveFileName('///')).toBe('parvane.zip');
    expect(archiveFileName('..')).toBe('parvane.zip');
  });

  it('длинное название обрезается по знакам, а не по половинкам суррогатных пар', () => {
    const name = archiveFileName('😀'.repeat(200));
    expect(Array.from(name.slice(0, -4))).toHaveLength(120);
    expect(name.endsWith('😀.zip')).toBe(true);
  });
});
