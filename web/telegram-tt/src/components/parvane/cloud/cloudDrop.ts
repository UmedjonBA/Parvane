import type { CloudNode } from './cloudModel';

import { canMoveInto, pathOf } from './cloudModel';

// Parvane (spec 041 E2, доски `XdFiles`, `ZdMisc`): перетаскивание в «Файлах» — что делать, когда строки отпустили
// на папку, и подписи зоны загрузки. Чистые функции; переносят существующие операции `cloudStore`

export type CloudDragEntry = { container: string; node: CloudNode };
// Куда отпустили: папка контейнера (`folder` не задан — его корень)
export type CloudDropTarget = { container: string; folder?: string };
export type CloudDropPlan =
  | { kind: 'same'; container: string; nodes: CloudNode[]; folder?: string }
  | { kind: 'across'; from: string; nodes: CloudNode[]; to: string; folder?: string };

/** Перенос перетащенного на папку: в том же контейнере — обычный перенос, в другой — перенос между ними.
 * `undefined` — отпускать некуда: папка в себе либо во вложенной, всё уже лежит там, строки из разных мест. */
export function planCloudDrop(
  dragged: CloudDragEntry[], target: CloudDropTarget, nodesOf: (container: string) => CloudNode[],
): CloudDropPlan | undefined {
  if (!dragged.length) return undefined;
  const from = dragged[0].container;
  if (dragged.some((entry) => entry.container !== from)) return undefined;
  const nodes = dragged.map((entry) => entry.node);
  if (target.container !== from) {
    return {
      kind: 'across', from, nodes, to: target.container, folder: target.folder,
    };
  }
  if (!canMoveInto(nodesOf(from), nodes.map((n) => n.id), target.folder)) return undefined;
  if (nodes.every((n) => (n.parent || undefined) === target.folder)) return undefined;
  return {
    kind: 'same', container: from, nodes, folder: target.folder,
  };
}

/** Что тащат: выделенные строки, если тащат одну из них, иначе только эту строку. */
export function pickDragged(entry: CloudDragEntry, selected: CloudDragEntry[]) {
  const isInSelection = selected.some((e) => e.container === entry.container && e.node.id === entry.node.id);
  return isInSelection ? selected : [entry];
}

/** Название места для подписи «Отпустите, чтобы загрузить в «Мой диск / Сервер»». */
export function dropPlaceTitle(
  placeName: string, containerName: string | undefined, nodes: CloudNode[], folder?: string,
) {
  return [placeName, containerName, ...pathOf(nodes, folder).map((n) => n.name)].filter(Boolean).join(' / ');
}
