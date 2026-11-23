import { setParvaneSection } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';

// Уже — телефон: плеер поверх всего; шире — внутри «Музыки»
const PHONE_MAX_WIDTH = 600;

const [getIsMusicPlayerOpen, setMusicPlayerOpen] = createSignal(false);

export { getIsMusicPlayerOpen };

/** Открыть плеер во весь экран; на компьютере он рисуется в «Музыке» — модуль открывается сам. */
export function openMusicPlayer() {
  setMusicPlayerOpen(true);
  if (window.innerWidth > PHONE_MAX_WIDTH) setParvaneSection('music');
}

export function closeMusicPlayer() {
  setMusicPlayerOpen(false);
}
