import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from './musicFormat';
import {
  cycleRepeat, getCurrentTrack, getMusicPlayer, getMusicPosition, playNext, playPrevious, seekTo, togglePlay,
  toggleShuffle,
} from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';
import screen from './MusicPlayerScreen.module.scss';

const REPEAT_KEYS = { off: 'MusicRepeatOff', all: 'MusicRepeatAll', one: 'MusicRepeatOne' } as const;

// Parvane (spec 039): управление плеером — позиция в треке и кнопки. Порядок («вперемешку», повтор) ведёт движок
const MusicControls = ({ isFullScreen }: { isFullScreen?: boolean }) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const { positionSecs, durationSecs } = useDerivedState(getMusicPosition);
  const track = getCurrentTrack(player);
  const total = durationSecs || track?.durationSecs || 0;
  const { shuffle, repeat } = player.queue;

  const handleSeek = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    seekTo(Number(e.currentTarget.value));
  });

  return (
    <div className={styles.controls} data-music-controls>
      <div className={buildClassName(styles.progress, isFullScreen && screen.progress)}>
        <input
          className={buildClassName(styles.slider, isFullScreen && screen.seek)}
          type="range"
          min={0}
          max={total || 1}
          value={Math.min(positionSecs, total)}
          disabled={!track}
          aria-label={lang('MusicPosition')}
          style={`--progress: ${total ? (Math.min(positionSecs, total) / total) * 100 : 0}%`}
          onChange={handleSeek}
        />
        <div className={buildClassName(styles.times, kit.mono, kit.muted, kit.small, isFullScreen && screen.times)}>
          <span data-music-position>{formatTrackTime(positionSecs)}</span>
          <span>{formatTrackTime(total)}</span>
        </div>
      </div>
      <div className={buildClassName(styles.buttons, isFullScreen && screen.playback)}>
        <button
          type="button"
          className={buildClassName(kit.ib, shuffle && styles.modeOn)}
          aria-label={lang(shuffle ? 'MusicShuffleOn' : 'MusicShuffleOff')}
          aria-pressed={shuffle}
          onClick={toggleShuffle}
        >
          <ParvaneIcon name="shuffle" isSmall />
        </button>
        <button type="button" className={kit.ib} aria-label={lang('MusicPrevious')} onClick={playPrevious}>
          <ParvaneIcon name="previous" />
        </button>
        <button
          type="button"
          className={buildClassName(styles.playButton, isFullScreen && screen.playButton)}
          aria-label={lang(player.isPlaying ? 'MusicPause' : 'MusicPlay')}
          data-music-play={player.isPlaying ? 'playing' : 'paused'}
          onClick={togglePlay}
        >
          <ParvaneIcon name={player.isPlaying ? 'pause' : 'play'} />
        </button>
        <button type="button" className={kit.ib} aria-label={lang('MusicNext')} onClick={playNext}>
          <ParvaneIcon name="next" />
        </button>
        <button
          type="button"
          className={buildClassName(kit.ib, repeat !== 'off' && styles.modeOn)}
          aria-label={lang(repeat === 'all' && player.source?.kind === 'playlist'
            ? 'MusicRepeatAllPlaylist' : REPEAT_KEYS[repeat])}
          data-music-repeat={repeat}
          onClick={cycleRepeat}
        >
          <ParvaneIcon name="repeat" isSmall />
          {repeat === 'one' && <span className={styles.repeatOne}>1</span>}
        </button>
      </div>
    </div>
  );
};

export default memo(MusicControls);
