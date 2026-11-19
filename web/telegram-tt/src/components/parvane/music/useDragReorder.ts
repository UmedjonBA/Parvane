import { useMemo, useState } from '../../../lib/teact/teact';

import useLastCallback from '../../../hooks/useLastCallback';

// Parvane (spec 041 C3, доска `MusicPlayer`): порядок строк списка перетаскиванием за ручку. События указателя —
// мышь и палец одинаково (на телефоне HTML5-перетаскивание не работает); ручка — кнопка, стрелки клавиатуры
// переставляют на одно место. Где окажется строка, решает `onMove` (очередь — движок MUSIC-1, плейлист — MUSIC-2)

export type DragRowState = 'dragged' | 'above' | 'below';

export type DragHandlers = {
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: NoneToVoidFunction;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
};

type Drag = { from: number; over: number };

// Строки списка — прямые потомки `ul`/`ol` с этим признаком
const ROW_SELECTOR = ':scope > [data-drag-row]';
const KEY_STEPS: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 };

export default function useDragReorder(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<Drag>();

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = Number(e.currentTarget.dataset.index);
    setDrag({ from, over: from });
  });

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const over = findRowAt(e.currentTarget, e.clientY);
    if (over !== undefined && over !== drag.over) setDrag({ from: drag.from, over });
  });

  const handlePointerUp = useLastCallback(() => {
    if (drag && drag.over !== drag.from) onMove(drag.from, drag.over);
    setDrag(undefined);
  });

  const handlePointerCancel = useLastCallback(() => setDrag(undefined));

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = KEY_STEPS[e.key];
    const from = Number(e.currentTarget.dataset.index);
    const to = from + step;
    if (!step || to < 0 || to >= count) return;
    e.preventDefault();
    onMove(from, to);
  });

  const handlers = useMemo<DragHandlers>(() => ({
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    onKeyDown: handleKeyDown,
  }), [handlePointerDown, handlePointerMove, handlePointerUp, handlePointerCancel, handleKeyDown]);

  function getRowState(index: number): DragRowState | undefined {
    if (!drag) return undefined;
    if (index === drag.from) return 'dragged';
    if (index !== drag.over) return undefined;
    return drag.over < drag.from ? 'above' : 'below';
  }

  return { handlers, getRowState };
}

// Номер строки под указателем; выше первой — первая, ниже последней — последняя
function findRowAt(handle: HTMLElement, clientY: number) {
  const list = handle.closest('[data-drag-row]')?.parentElement;
  if (!list) return undefined;
  const rows = Array.from(list.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  if (!rows.length) return undefined;
  const index = rows.findIndex((row) => clientY < row.getBoundingClientRect().bottom);
  return index === -1 ? rows.length - 1 : index;
}
