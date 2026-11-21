import { describe, expect, it } from 'vitest';

import type { CloudNode } from '../cloud/cloudModel';

import { replaceEmbedTarget, resolveEmbed } from './notesEmbeds';

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

describe('«Выбрать заново» у пропавшего файла', () => {
  it('строки-вложения с этим именем получают новый путь, подпись и прочий текст остаются', () => {
    const text = [
      'Схема:', '![[старая.png|схема сети]]', '  ![[старая.png]]', '![[другая.png]]', 'Текст ![[старая.png]] в строке',
      '![подпись](%D1%81%D1%82%D0%B0%D1%80%D0%B0%D1%8F.png)',
    ].join('\n');
    expect(replaceEmbedTarget(text, 'старая.png', 'Фото/новая сеть.png').split('\n')).toEqual([
      'Схема:', '![[Фото/новая сеть.png|схема сети]]', '  ![[Фото/новая сеть.png]]', '![[другая.png]]',
      'Текст ![[старая.png]] в строке', `![подпись](${encodeURI('Фото/новая сеть.png')})`,
    ]);
  });
});
