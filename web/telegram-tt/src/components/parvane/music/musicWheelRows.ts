import { requestMutation } from '../../../lib/fasterdom/fasterdom';

// Строка в пикселях при прокрутке колесом по строкам (`deltaMode` 1, Firefox)
const LINE_PX = 16;

/**
 * Колесо мыши над горизонтальной лентой (альбомы, исполнители, плитки) листает её вбок: полосы прокрутки у лент
 * скрыты, и на компьютере не уместившееся было не увидеть. Лента дошла до края — колесо снова листает страницу.
 */
export function scrollRowByWheel(e: WheelEvent, root: HTMLElement) {
  if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  let element = e.target instanceof HTMLElement ? e.target : undefined;
  while (element && element !== root) {
    if (isHorizontalRow(element)) {
      const max = element.scrollWidth - element.clientWidth;
      const canScroll = e.deltaY > 0 ? element.scrollLeft < max - 1 : element.scrollLeft > 0;
      if (!canScroll) return;
      e.preventDefault();
      const row = element;
      const delta = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaY;
      requestMutation(() => row.scrollBy({ left: delta }));
      return;
    }
    element = element.parentElement || undefined;
  }
}

function isHorizontalRow(element: HTMLElement) {
  if (element.scrollWidth <= element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) return false;
  const { overflowX } = getComputedStyle(element);
  return overflowX === 'auto' || overflowX === 'scroll';
}
