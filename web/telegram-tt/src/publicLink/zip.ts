import type { CloudSink } from '../api/parvane/cloudBlobs';

// Parvane (spec 022): «Скачать всё» на странице ссылки — ZIP без сжатия (STORE), который пишется потоком:
// заголовок файла уходит до его содержимого, CRC-32 и размер считаются на лету и пишутся дескриптором после
// него (флаг 3), имена — UTF-8 (флаг 11). Без ZIP64: архив меньше 4 ГиБ и меньше 65 535 элементов —
// пределы проверяет `canZip` до начала.

const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const VERSION = 20;
const FLAGS = 0x0808;
const LOCAL_BYTES = 30;
const DESCRIPTOR_BYTES = 16;
const CENTRAL_BYTES = 46;
const END_BYTES = 22;
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const DIR_ATTR = 0x10;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Уместятся ли файлы (открытые размеры) с именами в ZIP без ZIP64. */
export function canZip(entries: { name: string; size: number }[]) {
  if (entries.length >= MAX_ENTRIES) return false;
  const encoder = new TextEncoder();
  const total = entries.reduce((sum, { name, size }) => {
    const nameBytes = encoder.encode(name).length;
    return sum + LOCAL_BYTES + DESCRIPTOR_BYTES + CENTRAL_BYTES + nameBytes * 2 + size;
  }, END_BYTES);
  return total <= MAX_OFFSET;
}

// Знаки, которых не бывает в именах файлов Windows/macOS, и управляющие
// eslint-disable-next-line no-control-regex
const BAD_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
const ARCHIVE_NAME_MAX = 120;
const ARCHIVE_FALLBACK = 'parvane';

/** Имя архива «Скачать всё» по названию ссылки: без знаков, запрещённых в именах файлов, не длиннее
 * `ARCHIVE_NAME_MAX` знаков до `.zip`; пустое — `parvane.zip`, уже оканчивающееся на `.zip` — без второго. */
export function archiveFileName(title: string) {
  let base = title.replace(BAD_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (/\.zip$/i.test(base)) base = base.slice(0, -4);
  base = Array.from(base).slice(0, ARCHIVE_NAME_MAX).join('').replace(/^[\s.]+|[\s.]+$/g, '');
  return `${base || ARCHIVE_FALLBACK}.zip`;
}

function dosDateTime(at: Date) {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2);
  const date = (Math.max(0, at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  return { time, date };
}

type Entry = { name: Uint8Array; crc: number; size: number; offset: number; isDir: boolean };

export function createZipWriter(out: CloudSink, at = new Date()) {
  const { time, date } = dosDateTime(at);
  const entries: Entry[] = [];
  let offset = 0;
  let isOpen = false;

  async function put(bytes: Uint8Array) {
    await out.write(bytes);
    offset += bytes.length;
  }

  function localHeader(name: Uint8Array) {
    const head = new Uint8Array(LOCAL_BYTES + name.length);
    const view = new DataView(head.buffer);
    view.setUint32(0, LOCAL_SIG, true);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, FLAGS, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    // CRC и размеры — в дескрипторе после данных
    view.setUint16(26, name.length, true);
    head.set(name, LOCAL_BYTES);
    return head;
  }

  function descriptor(crc: number, size: number) {
    const tail = new Uint8Array(DESCRIPTOR_BYTES);
    const view = new DataView(tail.buffer);
    view.setUint32(0, DESCRIPTOR_SIG, true);
    view.setUint32(4, crc, true);
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
    return tail;
  }

  async function begin(path: string, isDir: boolean) {
    if (isOpen) throw new Error('zip: previous entry is not closed');
    const name = new TextEncoder().encode(isDir ? `${path}/` : path);
    const entry: Entry = {
      name, crc: 0, size: 0, offset, isDir,
    };
    await put(localHeader(name));
    entries.push(entry);
    return entry;
  }

  return {
    /** Папка без файлов: элемент `путь/` нулевой длины. */
    async addDir(path: string) {
      const entry = await begin(path, true);
      await put(descriptor(entry.crc, entry.size));
    },

    /** Приёмник одного файла: `close` закрывает файл в архиве, `abort` — весь архив. */
    async file(path: string): Promise<CloudSink> {
      const entry = await begin(path, false);
      isOpen = true;
      return {
        write: async (bytes) => {
          entry.crc = crc32(bytes, entry.crc);
          entry.size += bytes.length;
          await put(bytes);
        },
        close: async () => {
          isOpen = false;
          await put(descriptor(entry.crc, entry.size));
        },
        abort: () => out.abort(),
      };
    },

    /** Оглавление и конец архива; закрывает `out`. */
    async finish() {
      const start = offset;
      for (const entry of entries) {
        const head = new Uint8Array(CENTRAL_BYTES + entry.name.length);
        const view = new DataView(head.buffer);
        view.setUint32(0, CENTRAL_SIG, true);
        view.setUint16(4, VERSION, true);
        view.setUint16(6, VERSION, true);
        view.setUint16(8, FLAGS, true);
        view.setUint16(12, time, true);
        view.setUint16(14, date, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.size, true);
        view.setUint32(24, entry.size, true);
        view.setUint16(28, entry.name.length, true);
        view.setUint32(38, entry.isDir ? DIR_ATTR : 0, true);
        view.setUint32(42, entry.offset, true);
        head.set(entry.name, CENTRAL_BYTES);
        await put(head);
      }
      const end = new Uint8Array(END_BYTES);
      const view = new DataView(end.buffer);
      view.setUint32(0, END_SIG, true);
      view.setUint16(8, entries.length, true);
      view.setUint16(10, entries.length, true);
      view.setUint32(12, offset - start, true);
      view.setUint32(16, start, true);
      await put(end);
      await out.close();
    },
  };
}
