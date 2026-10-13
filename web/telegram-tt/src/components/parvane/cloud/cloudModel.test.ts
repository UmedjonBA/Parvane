import { describe, expect, it } from 'vitest';

import {
  canMoveInto, childrenOf, CLOUD_TRASH_LIFETIME_MS, type CloudNode, decodeTextPreview, expiredTrashOf, fileTypeLabel,
  folderStats, freeName, isServiceNode, kindOfFile, listedNodes, namesIn, pathOf, searchNodes, sizeOf, sortNodes,
  subtreeOf, trashDaysLeft, trashOf, usageOf, validateName,
} from './cloudModel';

function node(
  id: string, kind: 'folder' | 'file', name: string, parent?: string, extra: Partial<CloudNode> = {},
): CloudNode {
  return {
    id,
    kind,
    name,
    parent,
    size: kind === 'file' ? 10 : 0,
    mime: '',
    mtime: 0,
    trashed: false,
    trashTop: false,
    trashedAt: 0,
    ...extra,
  };
}

const TREE: CloudNode[] = [
  node('a', 'folder', 'Документы'),
  node('b', 'folder', 'Архив', 'a'),
  node('c', 'file', 'отчёт.pdf', 'b', { size: 300, mtime: 5 }),
  node('d', 'file', 'Фото 10.jpg', undefined, { size: 20, mtime: 9 }),
  node('e', 'file', 'фото 2.jpg', undefined, { size: 50, mtime: 1 }),
  node('f', 'folder', 'Старое', undefined, { trashed: true, trashTop: true, trashedAt: 7 }),
  node('g', 'file', 'черновик.txt', 'f', { trashed: true, size: 7 }),
  node('h', 'file', 'удалённый.txt', 'a', { trashed: true, trashTop: true, trashedAt: 9, size: 3 }),
];

describe('облако: модель дерева', () => {
  it('проверка имени совпадает с движком', () => {
    expect(validateName('отчёт.pdf')).toBeUndefined();
    expect(validateName('   ')).toBe('empty');
    expect(validateName('a/b')).toBe('bad-chars');
    expect(validateName('a\\b')).toBe('bad-chars');
    expect(validateName('a\u0001b')).toBe('bad-chars');
    expect(validateName('..')).toBe('reserved');
    expect(validateName('я'.repeat(128))).toBe('too-long');
    expect(validateName('я'.repeat(127))).toBeUndefined();
  });

  it('свободное имя получает номер перед расширением', () => {
    expect(freeName([], 'отчёт.pdf')).toBe('отчёт.pdf');
    expect(freeName(['отчёт.pdf'], 'отчёт.pdf')).toBe('отчёт (2).pdf');
    expect(freeName(['отчёт.pdf', 'отчёт (2).pdf'], 'отчёт.pdf')).toBe('отчёт (3).pdf');
    expect(freeName(['Папка'], 'Папка')).toBe('Папка (2)');
    expect(freeName(['.profile'], '.profile')).toBe('.profile (2)');
  });

  it('счётчики папок одним проходом совпадают с подсчётом по каждой', () => {
    const tree = [...TREE, node('s', 'file', '.parvane-guide', 'a', { size: 4 })];
    const stats = folderStats(tree);
    tree.filter((n) => n.kind === 'folder').forEach((folder) => {
      const expected = {
        count: childrenOf(listedNodes(tree), folder.id).length,
        size: sizeOf(tree, folder.id),
      };
      expect(stats.get(folder.id) || { count: 0, size: 0 }).toEqual(expected);
    });
    expect(stats.get('a')).toEqual({ count: 1, size: 307 });
    expect(stats.get('b')).toEqual({ count: 1, size: 300 });
    expect(stats.get('f')).toEqual({ count: 0, size: 7 });
  });

  it('содержимое папки, путь и поддерево без корзины', () => {
    expect(childrenOf(TREE).map((n) => n.id)).toEqual(['a', 'd', 'e']);
    expect(childrenOf(TREE, 'a').map((n) => n.id)).toEqual(['b']);
    expect(namesIn(TREE, undefined, 'd')).toEqual(['Документы', 'фото 2.jpg']);
    expect(pathOf(TREE, 'c').map((n) => n.name)).toEqual(['Документы', 'Архив', 'отчёт.pdf']);
    expect(pathOf(TREE)).toEqual([]);
    expect(subtreeOf(TREE, 'a').map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'h']);
    expect(sizeOf(TREE, 'a')).toBe(303);
  });

  it('перемещение: не в себя, не во вложенную, не в файл и не в корзину', () => {
    expect(canMoveInto(TREE, ['a'], 'a')).toBe(false);
    expect(canMoveInto(TREE, ['a'], 'b')).toBe(false);
    expect(canMoveInto(TREE, ['d'], 'c')).toBe(false);
    expect(canMoveInto(TREE, ['d'], 'f')).toBe(false);
    expect(canMoveInto(TREE, ['d', 'e'], 'b')).toBe(true);
    expect(canMoveInto(TREE, ['b'])).toBe(true);
  });

  it('сортировка держит папки выше файлов и считает числа в именах', () => {
    const root = childrenOf(TREE);
    expect(sortNodes(root, { key: 'name', isDescending: false }).map((n) => n.name))
      .toEqual(['Документы', 'фото 2.jpg', 'Фото 10.jpg']);
    expect(sortNodes(root, { key: 'name', isDescending: true }).map((n) => n.id)).toEqual(['a', 'd', 'e']);
    expect(sortNodes(root, { key: 'size', isDescending: true }).map((n) => n.id)).toEqual(['a', 'e', 'd']);
    expect(sortNodes(root, { key: 'date', isDescending: false }).map((n) => n.id)).toEqual(['a', 'e', 'd']);
  });

  it('поиск идёт по всему диску без учёта регистра и мимо корзины', () => {
    expect(searchNodes(TREE, 'ФОТО').map((n) => n.id)).toEqual(['d', 'e']);
    expect(searchNodes(TREE, 'отч').map((n) => n.id)).toEqual(['c']);
    expect(searchNodes(TREE, 'черновик')).toEqual([]);
    expect(searchNodes(TREE, '  ')).toEqual([]);
  });

  it('корзина показывает положенное явно, место считает с вложенным', () => {
    expect(trashOf(TREE).map((n) => n.id)).toEqual(['h', 'f']);
    expect(usageOf(TREE)).toEqual({ total: 380, trash: 10 });
  });

  it('срок корзины: стирается пролежавшее 30 дней, вложенное — вместе с папкой', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const tree = [
      node('live', 'file', 'живой.txt'),
      node('old', 'folder', 'Старая', undefined, { trashed: true, trashTop: true, trashedAt: now - 31 * day }),
      node('inside', 'file', 'внутри.txt', 'old', { trashed: true, trashedAt: now - 31 * day }),
      node('edge', 'file', 'ровно.txt', undefined, { trashed: true, trashTop: true, trashedAt: now - 30 * day }),
      node('fresh', 'file', 'свежий.txt', undefined, { trashed: true, trashTop: true, trashedAt: now - 29 * day }),
      node('later', 'file', 'часы вперёд.txt', undefined, { trashed: true, trashTop: true, trashedAt: now + day }),
      node('unknown', 'file', 'без времени.txt', undefined, { trashed: true, trashTop: true, trashedAt: 0 }),
      node('back', 'file', 'восстановлен.txt', undefined, { trashedAt: now - 40 * day }),
    ];
    expect(expiredTrashOf(tree, now).map((n) => n.id)).toEqual(['old', 'edge']);
    expect(expiredTrashOf(tree, now - day).map((n) => n.id)).toEqual(['old']);
    expect(expiredTrashOf(tree, now, day).map((n) => n.id)).toEqual(['old', 'edge', 'fresh']);
    expect(CLOUD_TRASH_LIFETIME_MS).toBe(30 * day);
  });

  it('срок корзины: сколько дней осталось', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const trashedAgo = (ms: number) => node('x', 'file', 'x', undefined, {
      trashed: true, trashTop: true, trashedAt: now - ms,
    });
    expect(trashDaysLeft(trashedAgo(0), now)).toBe(30);
    expect(trashDaysLeft(trashedAgo(1), now)).toBe(30);
    expect(trashDaysLeft(trashedAgo(day), now)).toBe(29);
    expect(trashDaysLeft(trashedAgo(29 * day + 1), now)).toBe(1);
    expect(trashDaysLeft(trashedAgo(30 * day), now)).toBe(0);
    expect(trashDaysLeft(trashedAgo(45 * day), now)).toBe(0);
    expect(trashDaysLeft(trashedAgo(-2 * day), now)).toBe(30);
    expect(trashDaysLeft(node('y', 'file', 'y', undefined, { trashed: true, trashTop: true }), now)).toBe(30);
  });

  it('вид файла по типу и расширению', () => {
    expect(kindOfFile('image/png', 'a')).toBe('photo');
    expect(kindOfFile('', 'снимок.JPG')).toBe('photo');
    expect(kindOfFile('image/svg+xml', 'a.svg')).toBe('text');
    expect(kindOfFile('video/mp4', 'a')).toBe('video');
    expect(kindOfFile('application/octet-stream', 'a.mp3')).toBe('audio');
    expect(kindOfFile('application/pdf', 'a')).toBe('pdf');
    expect(kindOfFile('', 'a.PDF')).toBe('pdf');
    expect(kindOfFile('application/zip', 'a.zip')).toBe('other');
  });

  it('текстовые файлы: заметки, данные и код — по расширению либо типу', () => {
    ['заметка.txt', 'Как пользоваться.md', 'Граф связей.canvas', 'data.JSON', 'таблица.csv', 'server.log',
      'main.rs', 'app.tsx', 'config.yaml', 'run.sh'].forEach((name) => {
      expect(kindOfFile('', name)).toBe('text');
    });
    expect(kindOfFile('text/plain', 'README')).toBe('text');
    expect(kindOfFile('text/x-python; charset=utf-8', 'script')).toBe('text');
    expect(kindOfFile('application/json', 'ответ')).toBe('text');
    // `.ts` браузер называет видео (MPEG-TS) — это исходный код
    expect(kindOfFile('video/mp2t', 'index.ts')).toBe('text');
    // Картинка и PDF остаются собой, даже если тип назван текстом
    expect(kindOfFile('text/plain', 'a.png')).toBe('photo');
    expect(kindOfFile('text/plain', 'a.pdf')).toBe('pdf');
    // Модель, архив, документ офиса — не текст
    ['деталь.3mf', 'a.stl', 'a.docx', 'a.xlsx', 'a.bin', 'без расширения'].forEach((name) => {
      expect(kindOfFile('application/octet-stream', name)).toBe('other');
    });
  });

  it('подпись типа файла — расширение прописными', () => {
    expect(fileTypeLabel('деталь.3mf')).toBe('3MF');
    expect(fileTypeLabel('архив.tar.gz')).toBe('GZ');
    expect(fileTypeLabel('схема.чертёж')).toBe('ЧЕРТЁЖ');
    expect(fileTypeLabel('без расширения')).toBe('');
    expect(fileTypeLabel('.скрытый')).toBe('');
    expect(fileTypeLabel('a.слишкомдлинное')).toBe('');
    expect(fileTypeLabel('a.b c')).toBe('');
  });

  it('текст для просмотра: UTF-8, UTF-16 с меткой, windows-1251; двоичное — нет', () => {
    const utf8 = new TextEncoder().encode('Привет, мир\n- [ ] пункт');
    expect(decodeTextPreview(utf8)).toBe('Привет, мир\n- [ ] пункт');
    expect(decodeTextPreview(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeTextPreview(new Uint8Array([0xff, 0xfe, 0x1f, 0x04, 0x40, 0x04]))).toBe('Пр');
    expect(decodeTextPreview(new Uint8Array([0xfe, 0xff, 0x04, 0x1f]))).toBe('П');
    // «Привет» в windows-1251 — не UTF-8
    expect(decodeTextPreview(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toBe('Привет');
    expect(decodeTextPreview(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeUndefined();
    expect(decodeTextPreview(new Uint8Array())).toBe('');
  });
});

describe('облако: служебные файлы Parvane', () => {
  const VAULT: CloudNode[] = [
    node('v', 'folder', 'Знания'),
    node('m', 'file', '.parvane-guide.json', 'v', { size: 40 }),
    node('n', 'file', 'Идея.md', 'v'),
    node('p', 'folder', '.parvane-папка', 'v'),
    node('q', 'file', '.PARVANE-other.json'),
    node('r', 'file', 'parvane-заметки.txt'),
    node('t', 'file', '.parvane-old.json', 'v', { trashed: true, trashTop: true, trashedAt: 3, size: 5 }),
  ];

  it('служебный — файл с именем на `.parvane-`; папка и обычное имя — нет', () => {
    expect(VAULT.filter(isServiceNode).map((n) => n.id)).toEqual(['m', 'q', 't']);
  });

  it('в списке папки, поиске и счётчике служебных файлов нет', () => {
    const listed = listedNodes(VAULT);
    expect(childrenOf(listed, 'v').map((n) => n.id)).toEqual(['n', 'p']);
    expect(childrenOf(listed).map((n) => n.id)).toEqual(['v', 'r']);
    expect(searchNodes(listed, 'parvane').map((n) => n.id)).toEqual(['p', 'r']);
    expect(searchNodes(listed, 'guide')).toEqual([]);
  });

  it('корзина, квота и занятые имена считают служебные файлы как обычные', () => {
    expect(trashOf(VAULT).map((n) => n.id)).toEqual(['t']);
    expect(usageOf(VAULT)).toEqual({ total: 75, trash: 5 });
    expect(namesIn(VAULT, 'v')).toContain('.parvane-guide.json');
  });

  it('без служебных файлов список возвращается тем же массивом', () => {
    expect(listedNodes(TREE)).toBe(TREE);
  });
});
