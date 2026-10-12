import { describe, expect, it } from 'vitest';

import type { CloudNode } from '../cloud/cloudModel';

import {
  buildLinkPreview, drivePathOf, fileNameOfPath, formatCardSize, hasPreviewContent, hostOf, noteTitleOfPath,
  resolveDrivePath,
} from './notesCanvasFiles';

function cloudNode(id: string, name: string, parent?: string, kind: CloudNode['kind'] = 'file', trashed = false) {
  return {
    id, kind, parent, name, size: 10, mime: '', mtime: 0, trashed, trashTop: trashed, trashedAt: 0,
  } satisfies CloudNode;
}

const NODES: CloudNode[] = [
  cloudNode('docs', 'Документы', undefined, 'folder'),
  cloudNode('sub', 'Сканы', 'docs', 'folder'),
  cloudNode('scan', 'паспорт.png', 'sub'),
  cloudNode('root-file', 'смета.xlsx'),
  cloudNode('old', 'старое.txt', 'docs', 'file', true),
  cloudNode('bin', 'Корзина', undefined, 'folder', true),
  cloudNode('bin-file', 'в корзине.txt', 'bin'),
  cloudNode('same', 'Сканы', 'docs'),
];

describe('путь файла личного диска', () => {
  it('путь от корня и обратно', () => {
    expect(drivePathOf(NODES, 'scan')).toBe('Документы/Сканы/паспорт.png');
    expect(drivePathOf(NODES, 'root-file')).toBe('смета.xlsx');
    expect(drivePathOf(NODES, 'нет')).toBe('');
    expect(resolveDrivePath(NODES, 'Документы/Сканы/паспорт.png')?.id).toBe('scan');
    expect(resolveDrivePath(NODES, 'смета.xlsx')?.id).toBe('root-file');
    expect(resolveDrivePath(NODES, '/Документы//Сканы/паспорт.png')?.id).toBe('scan');
  });

  it('папка и файл с одним названием не путаются', () => {
    // «Документы/Сканы» как файл — узел `same`, а как папка на пути — `sub`
    expect(resolveDrivePath(NODES, 'Документы/Сканы')?.id).toBe('same');
  });

  it('нет файла, файл в корзине, папка вместо файла — не найдено', () => {
    expect(resolveDrivePath(NODES, 'Документы/нет.png')).toBeUndefined();
    expect(resolveDrivePath(NODES, 'Документы/старое.txt')).toBeUndefined();
    expect(resolveDrivePath(NODES, 'Корзина/в корзине.txt')).toBeUndefined();
    expect(resolveDrivePath(NODES, 'Документы')).toBeUndefined();
    expect(resolveDrivePath(NODES, 'паспорт.png')).toBeUndefined();
    expect(resolveDrivePath(NODES, '')).toBeUndefined();
  });

  it('название заметки и имя файла по пути', () => {
    expect(noteTitleOfPath('Сервер X99.md')).toBe('Сервер X99');
    expect(noteTitleOfPath('Папка/Заметка.MD')).toBe('Заметка');
    expect(noteTitleOfPath('схема.png')).toBeUndefined();
    expect(noteTitleOfPath('.md')).toBeUndefined();
    expect(noteTitleOfPath(undefined)).toBeUndefined();
    expect(fileNameOfPath('Документы/Сканы/паспорт.png')).toBe('паспорт.png');
    expect(fileNameOfPath(undefined)).toBe('');
  });

  it('размер файла', () => {
    expect(formatCardSize(0)).toBe('0 B');
    expect(formatCardSize(900)).toBe('900 B');
    expect(formatCardSize(1536)).toBe('1.5 KB');
    expect(formatCardSize(2048)).toBe('2 KB');
    expect(formatCardSize(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatCardSize(5 * 1024 ** 4)).toBe('5120 GB');
  });
});

describe('превью ссылки', () => {
  it('узел сайта', () => {
    expect(hostOf('https://www.example.com/a/b?c=1')).toBe('example.com');
    expect(hostOf('https://docs.example.com')).toBe('docs.example.com');
    expect(hostOf('не адрес')).toBe('не адрес');
  });

  it('сведения чистятся, название-узел не повторяется', () => {
    const preview = buildLinkPreview('https://example.com/page', {
      title: '  Заголовок \n страницы ',
      description: '',
      siteName: 'Example.com',
      imageBase64: 'AAAA',
      imageMime: 'image/PNG',
    });
    expect(preview).toEqual({
      host: 'example.com',
      title: 'Заголовок страницы',
      description: undefined,
      siteName: undefined,
      imageBase64: 'AAAA',
      imageMime: 'image/png',
    });
    expect(hasPreviewContent(preview)).toBe(true);
    expect(buildLinkPreview('https://example.com', { title: 'example.com' }).title).toBeUndefined();
    expect(buildLinkPreview('https://example.com', { description: 'я'.repeat(900) }).description).toHaveLength(400);
  });

  it('нерастровая картинка и картинка без типа не показываются', () => {
    expect(buildLinkPreview('https://example.com', { imageBase64: 'AAAA', imageMime: 'image/svg+xml' }).imageBase64)
      .toBeUndefined();
    expect(buildLinkPreview('https://example.com', { imageBase64: 'AAAA' }).imageBase64).toBeUndefined();
  });

  it('превью недоступно — только узел сайта', () => {
    const preview = buildLinkPreview('https://example.com/page');
    expect(preview.host).toBe('example.com');
    expect(hasPreviewContent(preview)).toBe(false);
  });
});
