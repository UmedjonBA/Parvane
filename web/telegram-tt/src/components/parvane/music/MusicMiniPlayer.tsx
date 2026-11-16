import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { setParvaneSection } from '../../../util/parvaneSection';
import {
  getCurrentTrack, getMusicPlayer, getMusicPosition, playNext, togglePlay,
} from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';

import styles from './MusicMiniPlayer.module.scss';

type OwnProps = {
  // Виджет боковой панели на компьютере: обложка с полоской позиции; иначе — полоса над лентой телефона
  isCompact?: boolean;
};

// Parvane (spec 039, 041): плеер вне «Музыки» — играет в любом модуле. Телефон: полоса между содержимым и
// лентой (название, пауза, следующий). Компьютер: компактный виджет внизу боковой панели. Нажатие открывает
// «Музыку». Нечего играть — ничего не рисуется
const MusicMiniPlayer = ({ isCompact }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const { positionSecs, durationSecs } = useDerivedState(getMusicPosition);
  const track = getCurrentTrack(player);

  const handleOpen = useLastCallback(() => setParvaneSection('music'));

  if (!track) return undefined;

  const total = durationSecs || track.durationSecs;
  const progress = total ? Math.min(100, (positionSecs / total) * 100) : 0;

  if (isCompact) {
    return (
      <button
        type="button"
        className={styles.widget}
        aria-label={lang('MusicWidgetOpen', { title: track.title, artist: track.artist })}
        data-music-widget={player.isPlaying ? 'playing' : 'paused'}
        onClick={handleOpen}
      >
        <MusicCover
          coverId={track.coverId}
          toneId={track.albumId || track.id}
          size={48}
          className={styles.widgetCover}
        />
        <span className={styles.widgetTrack} aria-hidden>
          <span className={styles.widgetBar} style={`width: ${progress}%`} />
        </span>
      </button>
    );
  }

  return (
    <div
      className={styles.bar}
      style={`--progress: ${progress}%`}
      data-music-mini={player.isPlaying ? 'playing' : 'paused'}
    >
      <button type="button" className={styles.barOpen} aria-label={lang('MusicOpenPlayer')} onClick={handleOpen}>
        <MusicCover coverId={track.coverId} toneId={track.albumId || track.id} size={36} className={styles.barCover} />
        <span className={styles.barText}>
          <span className={styles.barTitle}>{track.title}</span>
          <span className={buildClassName(styles.barTitle, styles.barArtist)}>{track.artist}</span>
        </span>
      </button>
      <button
        type="button"
        className={styles.barButton}
        aria-label={lang(player.isPlaying ? 'MusicPause' : 'MusicPlay')}
        onClick={togglePlay}
      >
        <ParvaneIcon name={player.isPlaying ? 'pause' : 'play'} />
      </button>
      <button type="button" className={styles.barButton} aria-label={lang('MusicNext')} onClick={playNext}>
        <ParvaneIcon name="next" />
      </button>
    </div>
  );
};

export default memo(MusicMiniPlayer);
