import { createSignal } from '../../../util/signals';

const [getIsMusicPlayerOpen, setMusicPlayerOpen] = createSignal(false);

export { getIsMusicPlayerOpen };

export function openMusicPlayer() {
  setMusicPlayerOpen(true);
}

export function closeMusicPlayer() {
  setMusicPlayerOpen(false);
}
