import { describe, expect, it } from 'vitest';

import type { CloudDriveState, CloudNodeJson } from '../../../api/parvane/cloudDrive';

import { collectCloudFiles } from './paletteFiles';

function node(id: string, name: string, parent?: string, extra: Partial<CloudNodeJson> = {}): CloudNodeJson {
  return {
    id,
    kind: 'file',
    parent,
    name,
    size: 412,
    mime: 'text/plain',
    mtime: 1,
    trashed: false,
    trashTop: false,
    trashedAt: 0,
    ...extra,
  };
}

const MEMBERS: CloudDriveState['containers'][number]['members'] = [];

const DATA: CloudDriveState = {
  status: 'ready',
  rootId: 'root',
  containers: [
    {
      id: 'shared1', kind: 'shared', owner: 'bob@local', name: 'Сборки', hasKey: true, members: MEMBERS,
    },
    {
      id: 'root', kind: 'root', owner: 'alice@local', name: '', hasKey: true, members: MEMBERS,
    },
    {
      id: 'nokey', kind: 'shared', owner: 'carol@local', name: 'Чужая', hasKey: false, members: MEMBERS,
    },
  ],
  trees: {
    root: {
      name: '',
      count: 4,
      nodes: [
        node('f1', 'Сервер', undefined, { kind: 'folder', size: 0 }),
        node('n1', 'wg0.conf', 'f1'),
        node('n2', 'старое.txt', undefined, { trashed: true, trashTop: true }),
        node('n3', '.parvane-notes.json'),
      ],
    },
    shared1: { name: 'Сборки', count: 1, nodes: [node('s1', 'build.log')] },
    nokey: { name: 'Чужая', count: 1, nodes: [node('x1', 'secret.txt')] },
  },
};

describe('палитра: файлы', () => {
  it('личный диск первым, путь — «Мой диск / папка», корзина, служебные и контейнеры без ключа не ищутся', () => {
    const files = collectCloudFiles(DATA, 'Мой диск');
    expect(files.map(({ title, place }) => [title, place])).toEqual([
      ['Сервер', 'Мой диск'],
      ['wg0.conf', 'Мой диск / Сервер'],
      ['build.log', 'Сборки'],
    ]);
    expect(files[0].isFolder).toBe(true);
    expect(files[1]).toMatchObject({
      container: 'root', node: 'n1', module: 'files', group: 'file', size: 412,
    });
  });

  it('без данных облака — пусто', () => {
    expect(collectCloudFiles(undefined, 'Мой диск')).toEqual([]);
  });
});
