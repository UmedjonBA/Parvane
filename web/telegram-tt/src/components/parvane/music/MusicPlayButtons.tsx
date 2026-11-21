import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';

type OwnProps = {
  // Подписи по доске: «Играть / Вперемешку», «Играть всё / Вперемешку», «Слушать / Перемешать»
  playKey?: 'MusicPlayAll' | 'MusicPlayEverything' | 'MusicListen';
  shuffleKey?: 'MusicShufflePlay' | 'MusicShuffleMix';
  // «Перемешать» стоит первым (доска `ZdMusicX`, «Любимое»)
  isShuffleFirst?: boolean;
  isDisabled?: boolean;
  onPlay: NoneToVoidFunction;
  onShuffle: NoneToVoidFunction;
};

// Parvane (spec 041): «Играть» (акцентная, со значком) и «Вперемешку» — в шапке плейлиста, альбома, исполнителя,
// любимого
const MusicPlayButtons = ({
  playKey = 'MusicPlayAll', shuffleKey = 'MusicShufflePlay', isShuffleFirst, isDisabled, onPlay, onShuffle,
}: OwnProps) => {
  const lang = useLang();
  const play = (
    <button
      key="play"
      type="button"
      className={buildClassName(kit.btn, kit.btnAcc)}
      disabled={isDisabled}
      data-music-play-all
      onClick={onPlay}
    >
      <ParvaneIcon name="play" isSmall />
      {lang(playKey)}
    </button>
  );
  const shuffle = (
    <button
      key="shuffle"
      type="button"
      className={kit.btn}
      disabled={isDisabled}
      data-music-shuffle
      onClick={onShuffle}
    >
      {lang(shuffleKey)}
    </button>
  );
  return <>{isShuffleFirst ? [shuffle, play] : [play, shuffle]}</>;
};

export default memo(MusicPlayButtons);
