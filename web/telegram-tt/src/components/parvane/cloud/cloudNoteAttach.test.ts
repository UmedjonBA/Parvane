import { describe, expect, it } from 'vitest';

import type { CloudNode } from './cloudModel';

import { appendEmbed, embedTargetOf } from './cloudNoteAttach';

function node(id: string, kind: 'folder' | 'file', name: string, parent?: string): CloudNode {
  return {
    id,
    kind,
    name,
    parent,
    size: 0,
    mime: '',
    mtime: 0,
    trashed: false,
    trashTop: false,
    trashedAt: 0,
  };
}

const DRIVE: CloudNode[] = [
  node('vault', 'folder', 'Notes'),
  node('note', 'file', 'Поход.md', 'vault'),
  node('trip', 'folder', 'Фото'),
  node('map', 'file', 'карта.png', 'trip'),
  node('other', 'folder', 'Старое'),
  node('map2', 'file', 'карта.png', 'other'),
  node('near', 'file', 'список.txt', 'vault'),
];

describe('embedTargetOf', () => {
  it('uses the bare name when it resolves to this very file', () => {
    expect(embedTargetOf(DRIVE, DRIVE[6], 'note')).toBe('список.txt');
    expect(embedTargetOf(DRIVE, DRIVE[3], 'note')).toBe('карта.png');
  });

  it('uses the path when the name points to another file', () => {
    expect(embedTargetOf(DRIVE, DRIVE[5], 'note')).toBe('Старое/карта.png');
  });
});

describe('appendEmbed', () => {
  it('adds the embed as its own paragraph at the end', () => {
    expect(appendEmbed('# Поход\n\nвзять палатку\n\n', 'карта.png'))
      .toBe('# Поход\n\nвзять палатку\n\n![[карта.png]]\n');
    expect(appendEmbed('', 'карта.png')).toBe('![[карта.png]]\n');
  });
});
