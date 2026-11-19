import { describe, expect, it } from 'vitest';

import type { CloudNode } from './cloudModel';

import { dropPlaceTitle, pickDragged, planCloudDrop } from './cloudDrop';

function node(id: string, kind: 'folder' | 'file', name: string, parent?: string): CloudNode {
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
  };
}

const DRIVE = 'drive';
const SHARED = 'shared';
const TREE: CloudNode[] = [
  node('docs', 'folder', 'Документы'),
  node('old', 'folder', 'Архив', 'docs'),
  node('pic', 'file', 'кот.png'),
  node('txt', 'file', 'список.txt', 'docs'),
];
const nodesOf = (container: string) => (container === DRIVE ? TREE : []);
const entry = (id: string, container = DRIVE) => ({ container, node: TREE.find((n) => n.id === id)! });

describe('planCloudDrop', () => {
  it('file onto a folder of the same container is a plain move', () => {
    expect(planCloudDrop([entry('pic')], { container: DRIVE, folder: 'old' }, nodesOf)).toEqual({
      kind: 'same', container: DRIVE, nodes: [entry('pic').node], folder: 'old',
    });
  });

  it('folder cannot go into itself or its subfolder', () => {
    expect(planCloudDrop([entry('docs')], { container: DRIVE, folder: 'docs' }, nodesOf)).toBeUndefined();
    expect(planCloudDrop([entry('docs')], { container: DRIVE, folder: 'old' }, nodesOf)).toBeUndefined();
  });

  it('dropping where everything already lies does nothing', () => {
    expect(planCloudDrop([entry('txt')], { container: DRIVE, folder: 'docs' }, nodesOf)).toBeUndefined();
    expect(planCloudDrop([entry('pic')], { container: DRIVE }, nodesOf)).toBeUndefined();
  });

  it('file to the drive root from a folder', () => {
    expect(planCloudDrop([entry('txt')], { container: DRIVE }, nodesOf)?.kind).toBe('same');
  });

  it('another container — move across', () => {
    expect(planCloudDrop([entry('pic'), entry('txt')], { container: SHARED }, nodesOf)).toEqual({
      kind: 'across', from: DRIVE, nodes: [entry('pic').node, entry('txt').node], to: SHARED, folder: undefined,
    });
  });

  it('rows from different containers are not moved together', () => {
    expect(planCloudDrop([entry('pic'), entry('txt', SHARED)], { container: DRIVE, folder: 'old' }, nodesOf))
      .toBeUndefined();
  });
});

describe('pickDragged', () => {
  it('drags the whole selection when the row is in it, otherwise the row alone', () => {
    const selected = [entry('pic'), entry('txt')];
    expect(pickDragged(entry('txt'), selected)).toBe(selected);
    expect(pickDragged(entry('docs'), selected)).toEqual([entry('docs')]);
  });
});

describe('dropPlaceTitle', () => {
  it('joins the place, the shared folder and the path', () => {
    expect(dropPlaceTitle('Мой диск', undefined, TREE, 'old')).toBe('Мой диск / Документы / Архив');
    expect(dropPlaceTitle('Общие папки', 'Поход', [], undefined)).toBe('Общие папки / Поход');
  });
});
