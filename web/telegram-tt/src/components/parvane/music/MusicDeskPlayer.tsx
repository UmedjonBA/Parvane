import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from './musicFormat';
import {
  cycleRepeat, getCurrentTrack, getMusicPlayer, getMusicPosition, getMusicVolume, playNext, playPrevious, seekTo,
  setMusicVolume, setTrackStarred, togglePlay, toggleShuffle,
} from './musicPlayer';
import { openMusicPlayer } from './musicPlayerView';
import { getMusicView, goBackMusic, openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';

import styles from './MusicDeskPlayer.module.scss';

const REPEAT_KEYS = { off: 'MusicRepeatOff', all: 'MusicRepeatAll', one: 'MusicRepeatOne' } as const;

// Parvane (макет «Музыки» 23 ноя, доска `DeskMusic`): плеер компьютера внизу «Музыки» во всю ширину — трек с ♥
// слева, кнопки и время по центру, очередь и громкость справа. Нажатие на трек открывает плеер во весь экран
const MusicDeskPlayer = () => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const { positionSecs, durationSecs } = useDerivedState(getMusicPosition);
  const volume = useDerivedState(getMusicVolume);
  const view = useDerivedState(getMusicView);
  const track = getCurrentTrack(player);
  const isQueueOpen = view.kind === 'queue';

  const handleStar = useLastCallback(() => {
    if (track) void setTrackStarred(track, !track.isStarred);
  });

  const handleSeek = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    seekTo(Number(e.currentTarget.value));
  });

  const handleVolume = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setMusicVolume(Number(e.currentTarget.value) / 100);
  });

  const handleQueue = useLastCallback(() => {
    if (isQueueOpen) goBackMusic();
    else openMusicView({ kind: 'queue' });
  });

  if (!track) return undefined;

  const total = durationSecs || track.durationSecs;
  const { shuffle, repeat } = player.queue;

  return (
    <div className={styles.root} data-music-desk-player={player.isPlaying ? 'playing' : 'paused'}>
      <div className={styles.track}>
        <button type="button" className={styles.open} aria-label={lang('MusicOpenPlayer')} onClick={openMusicPlayer}>
          <MusicCover coverId={track.coverId} toneId={track.albumId || track.id} size={50} className={styles.cover} />
          <span className={styles.text}>
            <span className={styles.title}>{track.title}</span>
            <span className={styles.artist}>{track.artist}</span>
          </span>
        </button>
        <button
          type="button"
          className={buildClassName(styles.button, track.isStarred && styles.starred)}
          aria-label={lang(track.isStarred ? 'MusicUnstar' : 'MusicStar')}
          aria-pressed={track.isStarred}
          onClick={handleStar}
        >
          <ParvaneIcon name={track.isStarred ? 'heart' : 'heartPlus'} />
        </button>
      </div>
      <div className={styles.center}>
        <div className={styles.controls}>
          <button
            type="button"
            className={buildClassName(styles.button, shuffle && styles.on)}
            aria-label={lang(shuffle ? 'MusicShuffleOn' : 'MusicShuffleOff')}
            aria-pressed={shuffle}
            onClick={toggleShuffle}
          >
            <ParvaneIcon name="shuffle" isSmall />
          </button>
          <button type="button" className={styles.button} aria-label={lang('MusicPrevious')} onClick={playPrevious}>
            <ParvaneIcon name="previous" isSmall />
          </button>
          <button
            type="button"
            className={styles.play}
            aria-label={lang(player.isPlaying ? 'MusicPause' : 'MusicPlay')}
            data-music-desk-play
            onClick={togglePlay}
          >
            <ParvaneIcon name={player.isPlaying ? 'pause' : 'play'} isSmall />
          </button>
          <button type="button" className={styles.button} aria-label={lang('MusicNext')} onClick={playNext}>
            <ParvaneIcon name="next" isSmall />
          </button>
          <button
            type="button"
            className={buildClassName(styles.button, repeat !== 'off' && styles.on)}
            aria-label={lang(REPEAT_KEYS[repeat])}
            aria-pressed={repeat !== 'off'}
            data-music-repeat={repeat}
            onClick={cycleRepeat}
          >
            <ParvaneIcon name="repeat" isSmall />
          </button>
        </div>
        <div className={styles.time}>
          <span className={styles.clock}>{formatTrackTime(positionSecs)}</span>
          <input
            type="range"
            className={styles.range}
            min={0}
            max={Math.max(1, Math.round(total))}
            step={1}
            value={Math.round(positionSecs)}
            aria-label={lang('MusicPosition')}
            style={`--fill: ${total ? Math.min(100, (positionSecs / total) * 100) : 0}%`}
            onChange={handleSeek}
          />
          <span className={styles.clock}>{formatTrackTime(total)}</span>
        </div>
      </div>
      <div className={styles.side}>
        <button
          type="button"
          className={buildClassName(styles.button, isQueueOpen && styles.on)}
          aria-label={lang('MusicQueue')}
          aria-pressed={isQueueOpen}
          data-music-desk-queue
          onClick={handleQueue}
        >
          <ParvaneIcon name="list" isSmall />
        </button>
        <ParvaneIcon name="volume" isSmall className={styles.volumeIcon} />
        <input
          type="range"
          className={buildClassName(styles.range, styles.volume)}
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          aria-label={lang('MusicVolume')}
          style={`--fill: ${Math.round(volume * 100)}%`}
          onChange={handleVolume}
        />
      </div>
    </div>
  );
};

export default memo(MusicDeskPlayer);
