import { useRef, useState } from '../../../lib/teact/teact';

import useLastCallback from '../../../hooks/useLastCallback';

// Свайп строки вправо на телефоне (доска `RpMusicA-06`): строка едет за пальцем, слева открывается «В очередь»;
// отпустили дальше порога — действие. Вертикальный жест — прокрутка списка, строка не двигается
const START_PX = 10;
const TRIGGER_PX = 96;
const MAX_PX = 132;

export default function useSwipeQueue(isEnabled: boolean, onSwipe: NoneToVoidFunction) {
  const [offset, setOffset] = useState(0);
  const startRef = useRef<{ x: number; y: number; isSwiping: boolean; id: number }>();
  const swipedRef = useRef(false);
  // Сдвиг для конца жеста — из ссылки: события пальца приходят быстрее перерисовки
  const offsetRef = useRef(0);

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!isEnabled || e.pointerType !== 'touch') return;
    startRef.current = { x: e.clientX, y: e.clientY, isSwiping: false, id: e.pointerId };
  });

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start || start.id !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.isSwiping) {
      if (Math.abs(dy) > START_PX) {
        startRef.current = undefined;
        return;
      }
      if (dx < START_PX) return;
      start.isSwiping = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (err) {
        // Указатель уже отпущен — жест доведётся без захвата
      }
    }
    offsetRef.current = Math.max(0, Math.min(MAX_PX, dx));
    setOffset(offsetRef.current);
  });

  const handlePointerEnd = useLastCallback(() => {
    const start = startRef.current;
    startRef.current = undefined;
    if (!start?.isSwiping) return;
    swipedRef.current = true;
    if (offsetRef.current >= TRIGGER_PX) onSwipe();
    offsetRef.current = 0;
    setOffset(0);
  });

  // Нажатие сразу после свайпа — конец жеста, а не «играть»
  const consumeSwipe = useLastCallback(() => {
    const wasSwiped = swipedRef.current;
    swipedRef.current = false;
    return wasSwiped;
  });

  return {
    offset,
    consumeSwipe,
    handlers: isEnabled ? {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerEnd,
      onPointerCancel: handlePointerEnd,
    } : undefined,
  };
}
