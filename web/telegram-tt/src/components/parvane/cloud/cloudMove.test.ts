import { describe, expect, it } from 'vitest';

import type { CloudNode } from './cloudModel';
import type { CloudMoveSource } from './cloudMove';

import {
  buildMoveStep, buildMoveTree, canMoveToSpot, homeOf, moveCrumbs,
} from './cloudMove';

function node(id: string, kind: 'folder' | 'file', name: string, parent?: string): CloudNode {
  return {
    id, kind, name, parent, size: 0, mime: '', mtime: 0, trashed: false, trashTop: false, trashedAt: 0,
  };
}

const DRIVE: CloudMoveSource = {
  id: 'drive',
  name: 'Мой диск',
  nodes: [
    node('srv', 'folder', 'Сервер'),
    node('cfg', 'folder', 'Конфиги', 'srv'),
    node('bak', 'folder', 'Копии', 'srv'),
    node('old', 'folder', 'Старое', 'bak'),
    node('wg', 'file', 'wg0.conf', 'srv'),
    node('nft', 'file', 'nftables.conf', 'cfg'),
  ],
};
const SHARED: CloudMoveSource = {
  id: 'team', name: 'Сборки', isShared: true, members: 3, nodes: [node('rel', 'folder', 'Выпуски')],
};
const SOURCES = [DRIVE, SHARED];

describe('облако: окно «Переместить в…»', () => {
  it('место переносимого — папка первого из них', () => {
    expect(homeOf(SOURCES, ['wg'], 'drive')).toEqual({ place: 'drive', folder: 'srv' });
    expect(homeOf(SOURCES, [], 'drive')).toBeUndefined();
  });

  it('дерево: своя папка и место «здесь» недоступны, содержимое переносимой папки скрыто', () => {
    const rows = buildMoveTree(SOURCES, ['bak'], 'drive');
    expect(rows.map((r) => `${r.depth}:${r.name}:${r.isDisabled ? 'x' : ''}${r.isHere ? 'h' : ''}`)).toEqual([
      '0:Мой диск:', '1:Сервер:xh', '2:Конфиги:', '2:Копии:x', '0:Сборки:', '1:Выпуски:',
    ]);
  });

  it('шаг: в корне диска — его папки и совместные места, переносимая папка не показывается', () => {
    const root = buildMoveStep(SOURCES, { place: 'drive' }, ['bak'], 'drive');
    expect(root.map((r) => [r.name, r.count, r.isShared])).toEqual([['Сервер', 3, undefined], ['Сборки', 1, true]]);
    const inside = buildMoveStep(SOURCES, { place: 'drive', folder: 'srv' }, ['bak'], 'drive');
    expect(inside.map((r) => r.name)).toEqual(['Конфиги']);
    expect(buildMoveStep(SOURCES, { place: 'team' }, ['bak'], 'drive').map((r) => r.name)).toEqual(['Выпуски']);
  });

  it('путь шага и куда можно отпустить', () => {
    expect(moveCrumbs(SOURCES, { place: 'drive', folder: 'cfg' }).map((c) => c.name))
      .toEqual(['Мой диск', 'Сервер', 'Конфиги']);
    expect(moveCrumbs(SOURCES, { place: 'team', folder: 'rel' }).map((c) => c.name))
      .toEqual(['Мой диск', 'Сборки', 'Выпуски']);
    expect(canMoveToSpot(SOURCES, { place: 'drive', folder: 'srv' }, ['wg'], 'drive')).toBe(false);
    expect(canMoveToSpot(SOURCES, { place: 'drive', folder: 'cfg' }, ['wg'], 'drive')).toBe(true);
    expect(canMoveToSpot(SOURCES, { place: 'drive', folder: 'old' }, ['bak'], 'drive')).toBe(false);
    expect(canMoveToSpot(SOURCES, { place: 'team' }, ['bak'], 'drive')).toBe(true);
  });

  it('одно место без id — сохранение из чата: переносимого нет, всё доступно', () => {
    const single = [{ ...DRIVE, id: undefined }];
    expect(buildMoveTree(single, []).every((r) => !r.isDisabled)).toBe(true);
    expect(canMoveToSpot(single, {}, [])).toBe(true);
  });
});
