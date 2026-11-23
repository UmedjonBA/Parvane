import { memo } from '../../../lib/teact/teact';

import useLang from '../../../hooks/useLang';

import ParvaneIcon from '../../main/ParvaneIcon';

import styles from './MusicPlayButtons.module.scss';

type OwnProps = {
  // Подписи по доске: «Играть / Вперемешку», «Играть всё / Вперемешку», «Слушать / Перемешать»
  playKey?: 'MusicPlayAll' | 'MusicPlayEverything' | 'MusicListen';
  shuffleKey?: 'MusicShufflePlay' | 'MusicShuffleMix';
  isDisabled?: boolean;
  onPlay: NoneToVoidFunction;
  onShuffle: NoneToVoidFunction;
};

// Parvane (spec 041): «Играть» (акцентная, со значком) и «Вперемешку» — в шапке плейлиста, альбома, исполнителя,
// любимого
const MusicPlayButtons = ({
  playKey = 'MusicPlayAll', shuffleKey = 'MusicShufflePlay', isDisabled, onPlay, onShuffle,
}: OwnProps) => {
  const lang = useLang();
  // Макет 23 ноя (доски `MusicPlaylist`, `MusicLibrary-04`): «перемешать» значком, ▶ — круглая акцентная справа
  return (
    <>
      <button
        type="button"
        className={styles.shuffle}
        aria-label={lang(shuffleKey)}
        disabled={isDisabled}
        data-music-shuffle
        onClick={onShuffle}
      >
        <ParvaneIcon name="shuffle" />
      </button>
      <button
        type="button"
        className={styles.play}
        aria-label={lang(playKey)}
        disabled={isDisabled}
        data-music-play-all
        onClick={onPlay}
      >
        <ParvaneIcon name="play" />
      </button>
    </>
  );
};

export default memo(MusicPlayButtons);
