import { closeMusicPlayer } from './musicPlayerView';
import { goToMusicView } from './musicView';

// Parvane (spec 041 C, доски `XpMusic`, `ZdMusicX`): «К исполнителю» и «К альбому» из меню трека — строки трека
// стоят и вне главного экрана «Музыки» (плеер, очередь): полный плеер закрывается, «Музыка» открывает страницу

export type MusicGoTo = { kind: 'album' | 'artist'; id: string };

export function goToMusic(target: MusicGoTo) {
  closeMusicPlayer();
  goToMusicView({ kind: target.kind, id: target.id });
}
