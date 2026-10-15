import { describe, expect, it } from 'vitest';

import type { CloudNode } from '../cloud/cloudModel';

import { resolveEmbed } from './notesEmbeds';

const node = (id: string, name: string, parent?: string, kind: 'file' | 'folder' = 'file', trashed = false) => (
  {
    id, name, parent, kind, trashed, size: 1, mtime: 0, mime: '',
  } as unknown as CloudNode
);

describe('встроенные файлы заметки', () => {
  const nodes = [
    node('vault', 'Знания', undefined, 'folder'),
    node('trips', 'Походы', 'vault', 'folder'),
    node('note', 'Поход.md', 'trips'),
    node('near', 'фото.jpg', 'trips'),
    node('root-photo', 'фото.jpg'),
    node('deep', 'карта.png', 'trips'),
    node('top', 'карта.png', 'vault'),
    node('gone', 'старое.png', 'vault', 'file', true),
  ];

  it('имя без папок: рядом с заметкой, иначе ближе к корню; корзина не считается', () => {
    expect(resolveEmbed(nodes, 'фото.jpg', 'note')?.id).toBe('near');
    expect(resolveEmbed(nodes, 'фото.jpg')?.id).toBe('root-photo');
    expect(resolveEmbed(nodes, 'карта.png', 'note')?.id).toBe('deep');
    expect(resolveEmbed(nodes, 'старое.png', 'note')).toBeUndefined();
  });

  it('путь с папками — по концу пути', () => {
    expect(resolveEmbed(nodes, 'Походы/карта.png')?.id).toBe('deep');
    expect(resolveEmbed(nodes, 'Знания/карта.png')?.id).toBe('top');
    expect(resolveEmbed(nodes, 'Нет/карта.png')).toBeUndefined();
  });
});
