import type { CloudNode } from './cloudModel';

import {
  canMoveInto, childrenOf, listedNodes, pathOf, sortNodes,
} from './cloudModel';

// Parvane (spec 041 E2, доски `XpFiles`, `ZdFilesX`): окно «Переместить в…» — строки дерева (компьютер) и шага
// (телефон: папка за папкой), путь шага. Чистые функции над деревьями мест назначения

/** Место назначения: личный диск (первым) либо совместная папка; `id` не задан — единственное место окна. */
export type CloudMoveSource = { id?: string; name: string; isShared?: boolean; members?: number; nodes: CloudNode[] };
/** Папка места (`folder` не задан — корень места). */
export type CloudMoveSpot = { place?: string; folder?: string };
export type CloudMoveRow = CloudMoveSpot & {
  key: string;
  name: string;
  depth: number;
  isShared?: boolean;
  members?: number;
  // Шаг: сколько показываемого внутри
  count?: number;
  // Переносимое лежит здесь сейчас
  isHere: boolean;
  isDisabled: boolean;
};
export type CloudMoveCrumb = CloudMoveSpot & { key: string; name: string };

const NAME_SORT = { key: 'name', isDescending: false } as const;
const NO_IDS: string[] = [];

export function moveRowKey(place?: string, folder?: string) {
  return `${place || ''}/${folder || ''}`;
}

/** Переносимое в этом месте (в чужом для него месте запретных папок нет). */
function movedIn(sources: CloudMoveSource[], source: CloudMoveSource, movedIds: string[], sourcePlace?: string) {
  return sources.length === 1 || source.id === sourcePlace ? movedIds : NO_IDS;
}

/** Где переносимое лежит сейчас: место и папка первого из переносимых. */
export function homeOf(
  sources: CloudMoveSource[], movedIds: string[], sourcePlace?: string,
): CloudMoveSpot | undefined {
  if (!movedIds.length) return undefined;
  for (const source of sources) {
    const first = movedIn(sources, source, movedIds, sourcePlace).length
      ? source.nodes.find(({ id }) => id === movedIds[0]) : undefined;
    if (first) return { place: source.id, folder: first.parent || undefined };
  }
  return undefined;
}

function isSameSpot(a: CloudMoveSpot | undefined, b: CloudMoveSpot) {
  return Boolean(a) && a.place === b.place && (a.folder || undefined) === (b.folder || undefined);
}

/** Компьютер: дерево всех папок всех мест. Папка не может попасть в себя и во вложенную — её содержимое
 * не показывается; место, где переносимое уже лежит, помечено и выбрать его нельзя. */
export function buildMoveTree(sources: CloudMoveSource[], movedIds: string[], sourcePlace?: string) {
  const home = homeOf(sources, movedIds, sourcePlace);
  const rows: CloudMoveRow[] = [];
  sources.forEach((source) => {
    const moved = movedIn(sources, source, movedIds, sourcePlace);
    const rootHere = isSameSpot(home, { place: source.id });
    rows.push({
      key: moveRowKey(source.id),
      place: source.id,
      name: source.name,
      depth: 0,
      isShared: source.isShared,
      members: source.members,
      isHere: rootHere,
      isDisabled: rootHere,
    });
    const walk = (parent: string | undefined, depth: number) => {
      folderChildren(source, parent).forEach((node) => {
        const isMoved = moved.includes(node.id);
        const isHere = isSameSpot(home, { place: source.id, folder: node.id });
        rows.push({
          key: moveRowKey(source.id, node.id),
          place: source.id,
          folder: node.id,
          name: node.name,
          depth,
          isHere,
          isDisabled: isMoved || isHere || !canMoveInto(source.nodes, moved, node.id),
        });
        if (!isMoved) walk(node.id, depth + 1);
      });
    };
    walk(undefined, 1);
  });
  return rows;
}

/** Телефон: папки одного шага. В корне первого места (личного диска) после его папок идут остальные места
 * (совместные папки); переносимые папки не показываются вовсе — ни выбрать, ни открыть. */
export function buildMoveStep(
  sources: CloudMoveSource[], spot: CloudMoveSpot, movedIds: string[], sourcePlace?: string,
) {
  const source = sources.find(({ id }) => id === spot.place) || sources[0];
  if (!source) return [];
  const home = homeOf(sources, movedIds, sourcePlace);
  const moved = movedIn(sources, source, movedIds, sourcePlace);
  const listed = listedNodes(source.nodes);
  const rows: CloudMoveRow[] = folderChildren(source, spot.folder)
    .filter((node) => !moved.includes(node.id))
    .map((node) => {
      const isHere = isSameSpot(home, { place: source.id, folder: node.id });
      return {
        key: moveRowKey(source.id, node.id),
        place: source.id,
        folder: node.id,
        name: node.name,
        depth: 0,
        count: childrenOf(listed, node.id).length,
        isHere,
        isDisabled: isHere,
      };
    });
  if (source === sources[0] && !spot.folder) {
    sources.slice(1).forEach((other) => {
      const isHere = isSameSpot(home, { place: other.id });
      rows.push({
        key: moveRowKey(other.id),
        place: other.id,
        name: other.name,
        depth: 0,
        isShared: other.isShared,
        members: other.members,
        count: childrenOf(listedNodes(other.nodes)).length,
        isHere,
        isDisabled: isHere,
      });
    });
  }
  return rows;
}

/** Путь шага: первое место, затем место шага (если другое) и папки до открытой. */
export function moveCrumbs(sources: CloudMoveSource[], spot: CloudMoveSpot): CloudMoveCrumb[] {
  const first = sources[0];
  if (!first) return [];
  const source = sources.find(({ id }) => id === spot.place) || first;
  const crumbs: CloudMoveCrumb[] = [{ key: moveRowKey(first.id), place: first.id, name: first.name }];
  if (source !== first) crumbs.push({ key: moveRowKey(source.id), place: source.id, name: source.name });
  pathOf(source.nodes, spot.folder).forEach((node) => {
    crumbs.push({
      key: moveRowKey(source.id, node.id), place: source.id, folder: node.id, name: node.name,
    });
  });
  return crumbs;
}

/** Можно ли перенести в папку шага (в неё саму, а не во вложенную): не туда, где переносимое уже лежит. */
export function canMoveToSpot(
  sources: CloudMoveSource[], spot: CloudMoveSpot, movedIds: string[], sourcePlace?: string,
) {
  const source = sources.find(({ id }) => id === spot.place) || sources[0];
  if (!source) return false;
  if (isSameSpot(homeOf(sources, movedIds, sourcePlace), spot)) return false;
  return canMoveInto(source.nodes, movedIn(sources, source, movedIds, sourcePlace), spot.folder);
}

function folderChildren(source: CloudMoveSource, parent?: string) {
  return sortNodes(childrenOf(source.nodes, parent).filter((n) => n.kind === 'folder'), NAME_SORT);
}
