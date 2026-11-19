import { setParvaneSection } from '../../../util/parvaneSection';
import { createSignal } from '../../../util/signals';
import { closeMusicPlayer } from './musicPlayerView';

// Parvane (spec 041 C, доски `XpMusic`, `ZdMusicX`): «К исполнителю» и «К альбому» из меню трека — строки трека
// стоят и вне главного экрана «Музыки» (плеер, очередь), поэтому переход идёт сигналом, который читает `Music.tsx`

export type MusicGoTo = { kind: 'album' | 'artist'; id: string };

const [getMusicGoTo, setMusicGoTo] = createSignal<MusicGoTo | undefined>(undefined);

export { getMusicGoTo };

export function goToMusic(target: MusicGoTo) {
  closeMusicPlayer();
  setParvaneSection('music');
  setMusicGoTo({ ...target });
}

/** Переход выполнен: при следующем открытии «Музыки» он не повторяется. */
export function consumeMusicGoTo() {
  setMusicGoTo(undefined);
}
