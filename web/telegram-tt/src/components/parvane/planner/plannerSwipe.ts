// Листание дней жестом на телефоне: горизонтальный свайп по экрану «Плана»

export type SwipePoint = { x: number; y: number };

// Короче этого — не листание, а нажатие либо дрожание пальца, px
const SWIPE_MIN_DISTANCE = 60;
// Жест считается горизонтальным, пока вертикальный ход не больше этой доли горизонтального
const SWIPE_MAX_SLOPE = 0.7;
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll']);
const TEXT_FIELDS = 'input, textarea, select, [contenteditable="true"]';

/** Сдвиг периода по жесту: 1 — вперёд (палец ушёл влево), -1 — назад, 0 — жест не листание. */
export function getSwipeDelta(start: SwipePoint, end: SwipePoint): -1 | 0 | 1 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * Жест, начатый здесь, принадлежит не листанию: поле ввода либо ребёнок `root`, который сам листается вбок
 * (шкала дня, лента плашек).
 */
export function isSwipeBlocked(target: Element, root: Element) {
  if (target.closest(TEXT_FIELDS)) return true;
  let element: Element | undefined = target;
  while (element && element !== root) {
    if (element.scrollWidth > element.clientWidth
      && SCROLLABLE_OVERFLOW.has(getComputedStyle(element).overflowX)) return true;
    element = element.parentElement || undefined;
  }
  return false;
}
