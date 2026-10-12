// Parvane, раздел «Знания»: что начинает нажатие на поле холста — сдвиг поля, сдвиг группы или карточки,
// рамку выделения, размер, стрелку. Чистые функции: решение по тому, что лежит под указателем.

import type {
  CanvasDoc, CanvasNode, CanvasPoint, CanvasSide,
} from './notesCanvas';
import type { CanvasHandle } from './notesCanvasEdit';

// Нажатие: клавиши и режимы плюс то, что под указателем. `nodeId` — узел, найденный по элементу страницы
// (карточка, а у группы — шапка, граница и ручки); `groupId` — группа, внутри которой лежит точка
export type CanvasPress = {
  // Средняя кнопка либо зажатый пробел: поле двигается, что бы ни было под указателем
  isPanForced?: boolean;
  // Shift, Ctrl, Cmd либо режим «Выбрать несколько»
  isAdditive?: boolean;
  // Режим «Связать»: следующее нажатие выбирает вторую карточку
  isLinking?: boolean;
  nodeId?: string;
  port?: CanvasSide;
  handle?: CanvasHandle;
  edgeId?: string;
  groupId?: string;
};

export type CanvasPressAction =
  | { kind: 'pan' }
  | { kind: 'arrow'; id: string; side: CanvasSide }
  | { kind: 'resize'; id: string; handle: CanvasHandle }
  | { kind: 'link'; id?: string }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'marquee' }
  | { kind: 'group'; id: string }
  | { kind: 'board' };

// Группа, внутри которой лежит точка (граница считается). Из вложенных — самая внутренняя: наименьшая по
// площади, при равенстве — та, что нарисована выше
export function groupAtPoint(doc: CanvasDoc, point: CanvasPoint): CanvasNode | undefined {
  let found: CanvasNode | undefined;
  doc.nodes.forEach((node) => {
    if (node.type !== 'group') return;
    if (point.x < node.x || point.y < node.y || point.x > node.x + node.width || point.y > node.y + node.height) {
      return;
    }
    if (!found || node.width * node.height <= found.width * found.height) found = node;
  });
  return found;
}

// Что начинает нажатие. По старшинству: сдвиг поля средней кнопкой и пробелом; точка стрелки и ручка
// размера (они лежат поверх узла); выбор второй карточки в режиме «Связать»; узел под указателем; стрелка;
// рамка выделения (с Shift она рисуется и внутри группы); пустое место внутри группы — сдвиг этой группы;
// пустое место вне групп — сдвиг поля
export function pressAction(press: CanvasPress): CanvasPressAction {
  const {
    isPanForced, isAdditive, isLinking, nodeId, port, handle, edgeId, groupId,
  } = press;
  if (isPanForced) return { kind: 'pan' };
  if (nodeId && port) return { kind: 'arrow', id: nodeId, side: port };
  if (nodeId && handle) return { kind: 'resize', id: nodeId, handle };
  if (isLinking) return { kind: 'link', id: nodeId };
  if (nodeId) return { kind: 'node', id: nodeId };
  if (edgeId) return { kind: 'edge', id: edgeId };
  if (isAdditive) return { kind: 'marquee' };
  if (groupId) return { kind: 'group', id: groupId };
  return { kind: 'board' };
}
