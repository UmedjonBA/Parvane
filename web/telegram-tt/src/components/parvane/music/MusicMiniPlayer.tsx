import {
  memo, useEffect, useRef,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { setParvaneSection } from '../../../util/parvaneSection';
import { formatTrackTime } from './musicFormat';
import {
  getCurrentTrack, getMusicPlayer, getMusicPosition, playNext, playPrevious, togglePlay,
} from './musicPlayer';
import { openMusicPlayer } from './musicPlayerView';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';

import styles from './MusicMiniPlayer.module.scss';

type OwnProps = {
  // Виджет боковой панели на компьютере: обложка с полоской позиции; иначе — полоса над лентой телефона
  isCompact?: boolean;
  // Внизу страницы «Музыки» на телефоне (лента модулей закрыта страницей) — в потоке, а не над лентой
  isDocked?: boolean;
};

// Parvane (spec 039, 041): плеер вне «Музыки» — играет в любом модуле. Телефон: полоса между содержимым и
// лентой (название, пауза, следующий); нажатие открывает полноэкранный плеер. Компьютер: компактный виджет внизу
// боковой панели; нажатие открывает окошко плеера рядом (доска `DeskNotes`): управление, «Очередь» (полноэкранный
// плеер с очередью) и «Открыть «Музыку»». Нечего играть — ничего не рисуется
const MusicMiniPlayer = ({ isCompact, isDocked }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const { positionSecs, durationSecs } = useDerivedState(getMusicPosition);
  const track = getCurrentTrack(player);
  const [isPopupOpen, openPopup, closePopup] = useFlag();
  const rootRef = useRef<HTMLDivElement>();

  const isPopupShown = Boolean(isCompact && track && isPopupOpen);

  // Окошко закрывают Escape и нажатие мимо него
  useEffect(() => {
    if (!isPopupShown) return undefined;
    const handlePointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closePopup();
    };
    document.addEventListener('pointerdown', handlePointer, true);
    const releaseEsc = captureEscKeyListener(closePopup);
    return () => {
      document.removeEventListener('pointerdown', handlePointer, true);
      releaseEsc();
    };
  }, [isPopupShown, closePopup]);

  const handleToggle = useLastCallback(() => {
    if (isPopupOpen) closePopup();
    else openPopup();
  });

  const handleQueue = useLastCallback(() => {
    closePopup();
    openMusicPlayer();
  });

  const handleOpenModule = useLastCallback(() => {
    closePopup();
    setParvaneSection('music');
  });

  if (!track) return undefined;

  const total = durationSecs || track.durationSecs;
  const progress = total ? Math.min(100, (positionSecs / total) * 100) : 0;

  if (isCompact) {
    return (
      <div ref={rootRef} className={styles.widgetRoot}>
        <button
          type="button"
          className={styles.widget}
          aria-label={lang('MusicWidgetOpen', { title: track.title, artist: track.artist })}
          aria-expanded={isPopupOpen}
          aria-haspopup="dialog"
          data-music-widget={player.isPlaying ? 'playing' : 'paused'}
          onClick={handleToggle}
        >
          <MusicCover
            coverId={track.coverId}
            toneId={track.albumId || track.id}
            size={48}
            className={styles.widgetCover}
          />
          {/* Состояние поверх обложки (доска `DeskMusic`): пауза — играет, треугольник — на паузе */}
          <span className={styles.widgetState} aria-hidden>
            <ParvaneIcon name={player.isPlaying ? 'pause' : 'play'} />
          </span>
          <span className={styles.widgetTrack} aria-hidden>
            <span className={styles.widgetBar} style={`width: ${progress}%`} />
          </span>
        </button>
        {isPopupShown && (
          <div role="dialog" aria-label={lang('MusicMiniDialog')} className={styles.popup} data-music-popup>
            <div className={styles.popupHead}>
              <MusicCover coverId={track.coverId} toneId={track.albumId || track.id} size={44} />
              <span className={styles.barText}>
                <span className={styles.popupTitle}>{track.title}</span>
                <span className={buildClassName(styles.barTitle, styles.barArtist)}>{track.artist}</span>
              </span>
            </div>
            <div className={styles.popupTime}>
              <span>{formatTrackTime(positionSecs)}</span>
              <span className={styles.popupTrack} aria-hidden>
                <span className={styles.popupBar} style={`width: ${progress}%`} />
              </span>
              <span>{formatTrackTime(total)}</span>
            </div>
            <div className={styles.popupControls}>
              <button
                type="button"
                className={styles.barButton}
                aria-label={lang('MusicPrevious')}
                onClick={playPrevious}
              >
                <ParvaneIcon name="previous" />
              </button>
              <button
                type="button"
                className={styles.popupPlay}
                aria-label={lang(player.isPlaying ? 'MusicPause' : 'MusicPlay')}
                data-music-popup-play
                onClick={togglePlay}
              >
                <ParvaneIcon name={player.isPlaying ? 'pause' : 'play'} />
              </button>
              <button type="button" className={styles.barButton} aria-label={lang('MusicNext')} onClick={playNext}>
                <ParvaneIcon name="next" />
              </button>
            </div>
            <div className={styles.popupActions}>
              <button type="button" className={styles.popupAction} data-music-popup-queue onClick={handleQueue}>
                {lang('MusicMiniQueue')}
              </button>
              <button type="button" className={styles.popupAction} data-music-popup-open onClick={handleOpenModule}>
                {lang('MusicMiniOpenModule')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={buildClassName(styles.bar, isDocked && styles.barDocked)}
      style={`--progress: ${progress}%`}
      data-music-mini={player.isPlaying ? 'playing' : 'paused'}
    >
      <button type="button" className={styles.barOpen} aria-label={lang('MusicOpenPlayer')} onClick={openMusicPlayer}>
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
