import { requestMutation } from '../lib/fasterdom/fasterdom';

// Строка в пикселях при прокрутке колесом по строкам (`deltaMode` 1, Firefox)
const LINE_PX = 16;

let isInstalled = false;

/**
 * Parvane: колесо мыши над горизонтальной лентой (альбомы, исполнители, чипы, плитки) листает её вбок — у лент
 * скрыты полосы прокрутки, и на компьютере не уместившееся было не увидеть. Один слушатель на всё приложение; лента,
 * которая листается колесом сама (её обработчик уже отменил событие), не трогается.
 */
export function installWheelRows() {
  if (isInstalled) return;
  isInstalled = true;
  document.addEventListener('wheel', scrollRowByWheel, { passive: false });
}

/** Лента дошла до края — колесо снова листает страницу. */
function scrollRowByWheel(e: WheelEvent) {
  if (e.defaultPrevented || e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  let element = e.target instanceof HTMLElement ? e.target : undefined;
  while (element && element !== document.body) {
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
