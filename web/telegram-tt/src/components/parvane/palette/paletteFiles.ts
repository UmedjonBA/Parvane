import type { CloudDriveState } from '../../../api/parvane/cloudDrive';
import type { PaletteItem } from './paletteSearch';

import { listedNodes, pathOf } from '../cloud/cloudModel';

// Parvane: файлы и папки «Файлов» для общего поиска (доски `XpStart`, `DeskOverlays`): имена из дерева `cloud.v1`
// на устройстве — сервер имён не видит, поиск идёт только здесь. Корзина и служебные файлы не ищутся
export type PaletteFileItem = PaletteItem & {
  group: 'file';
  container: string;
  node: string;
  isFolder: boolean;
  // Место: «Мой диск / Сервер» — контейнер и папки до файла
  place: string;
  size: number;
};

/** Узлы всех контейнеров с ключом: личный диск первым, затем совместные папки. */
export function collectCloudFiles(data: CloudDriveState | undefined, driveName: string): PaletteFileItem[] {
  if (!data) return [];
  const containers = [...data.containers]
    .filter((container) => container.hasKey && data.trees[container.id])
    .sort((a, b) => Number(b.id === data.rootId) - Number(a.id === data.rootId));
  const result: PaletteFileItem[] = [];
  containers.forEach((container) => {
    const nodes = data.trees[container.id].nodes;
    const label = container.id === data.rootId ? driveName : container.name;
    listedNodes(nodes).forEach((node) => {
      if (node.trashed) return;
      const folders = pathOf(nodes, node.parent).map(({ name }) => name);
      result.push({
        key: `file:${container.id}:${node.id}`,
        group: 'file',
        module: 'files',
        title: node.name,
        container: container.id,
        node: node.id,
        isFolder: node.kind === 'folder',
        place: [label, ...folders].join(' / '),
        size: node.size,
      });
    });
  });
  return result;
}
