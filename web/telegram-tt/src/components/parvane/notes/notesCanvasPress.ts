// Parvane, раздел «Знания»: что начинает нажатие на поле холста — сдвиг поля, сдвиг группы или карточки,
// рамку выделения, размер, стрелку. Чистые функции: решение по тому, что лежит под указателем.

import type { CanvasSide } from './notesCanvas';
import type { CanvasHandle } from './notesCanvasEdit';

// Нажатие: клавиши и режимы плюс то, что под указателем. `nodeId` — узел, найденный по элементу страницы
// (карточка, а у группы — шапка, граница и ручки)
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
};

export type CanvasPressAction =
  | { kind: 'pan' }
  | { kind: 'arrow'; id: string; side: CanvasSide }
  | { kind: 'resize'; id: string; handle: CanvasHandle }
  | { kind: 'link'; id?: string }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'marquee' }
  | { kind: 'board' };

// Что начинает нажатие. По старшинству: сдвиг поля средней кнопкой и пробелом; точка стрелки и ручка
// размера (они лежат поверх узла); выбор второй карточки в режиме «Связать»; узел под указателем; стрелка;
// рамка выделения (с Shift она рисуется и внутри группы); пустое место — сдвиг поля, и внутри группы тоже:
// группу берут только за шапку и границу (на телефоне большая группа иначе не давала двигаться по холсту)
export function pressAction(press: CanvasPress): CanvasPressAction {
  const {
    isPanForced, isAdditive, isLinking, nodeId, port, handle, edgeId,
  } = press;
  if (isPanForced) return { kind: 'pan' };
  if (nodeId && port) return { kind: 'arrow', id: nodeId, side: port };
  if (nodeId && handle) return { kind: 'resize', id: nodeId, handle };
  if (isLinking) return { kind: 'link', id: nodeId };
  if (nodeId) return { kind: 'node', id: nodeId };
  if (edgeId) return { kind: 'edge', id: edgeId };
  if (isAdditive) return { kind: 'marquee' };
  return { kind: 'board' };
}
