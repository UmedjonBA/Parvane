import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { ApiMusicTrackCard } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from '../../parvane/music/musicFormat';
import {
  callMusic, getMusicInfo, loadMusicInfo, playTracks,
} from '../../parvane/music/musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import Icon from '../../common/icons/Icon';
import MusicOfflineButton from '../../parvane/music/MusicOfflineButton';
import PvModuleOff from '../../parvane/notes/PvModuleOff';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './MusicTrackCard.module.scss';

type OwnProps = {
  track: ApiMusicTrackCard;
};

// Parvane (TRACK-1): трек «Музыки» в чате — карточка с названием и исполнителем. Играет из библиотеки своего
// сервера: байтов трека в сообщении нет. Трек чужого сервера либо убранный из библиотеки только показывается
const MusicTrackCard = ({ track }: OwnProps) => {
  const lang = useLang();
  const gate = useModuleGate('music');
  const [problem, setProblem] = useState<'missing' | 'failed'>();
  const info = useDerivedState(getMusicInfo);
  const isMusicOn = gate.isOn;
  // Чей это трек, известно после сведений о «Музыке»: до них карточка только показывает
  const isOwnServer = info ? info.server === track.server : undefined;
  const canPlay = Boolean(isOwnServer && info?.isEnabled && isMusicOn);
  // «Скачать для офлайна» (доска `MusicChat`): в «Загруженном» трек виден с подписями карточки
  const offlineTrack = useMemo<MusicTrack>(() => ({
    id: track.trackId,
    title: track.title,
    artist: track.artist,
    album: '',
    albumId: '',
    artistId: '',
    durationSecs: track.durationSecs,
    coverId: '',
    trackNo: 0,
    year: 0,
    isStarred: false,
  }), [track]);

  useEffect(() => {
    if (isMusicOn && !getMusicInfo()) void loadMusicInfo().catch(() => undefined);
  }, [isMusicOn]);

  const handlePlay = useLastCallback(async () => {
    try {
      const found = await callMusic('parvaneMusicTracks', { trackIds: [track.trackId] });
      if (!found.length) {
        setProblem('missing');
        return;
      }
      setProblem(undefined);
      playTracks(found, 0);
    } catch {
      setProblem('failed');
    }
  });

  // «Музыка» выключена на устройстве: кнопка ведёт в лист «Модуль выключен», после включения трек играет,
  // если он с этого сервера
  const handlePlayClick = useLastCallback(() => {
    gate.run(async () => {
      const known = getMusicInfo() || await loadMusicInfo().catch(() => undefined);
      if (known?.isEnabled && known.server === track.server) void handlePlay();
    });
  });

  return (
    <div className={styles.root} data-music-track-card={track.trackId}>
      <div className={styles.head}>
        {canPlay || gate.canEnable ? (
          <button
            type="button"
            className={styles.play}
            aria-label={lang('MusicTrackCardPlay')}
            onClick={handlePlayClick}
          >
            <Icon name="play" />
          </button>
        ) : (
          <span className={buildClassName(styles.play, styles.playOff)} aria-hidden>
            <Icon name="play" />
          </span>
        )}
        <div className={styles.titles}>
          <div className={styles.title}>{track.title}</div>
          {track.artist && <div className={styles.artist}>{track.artist}</div>}
        </div>
        {canPlay && <MusicOfflineButton track={offlineTrack} />}
      </div>
      <div className={styles.source}>
        <Icon name="volume-1" className={styles.sourceIcon} />
        <span>
          {`${lang('MusicTrackCardLabel')} · `}
          <span className={kit.mono}>{formatTrackTime(track.durationSecs)}</span>
        </span>
      </div>
      {isOwnServer === false && (
        <p className={styles.note}>{lang('MusicTrackCardOtherServer', { server: track.server })}</p>
      )}
      {problem && (
        <p className={styles.note} role="status" data-track-problem={problem}>
          {lang(problem === 'missing' ? 'MusicTrackCardMissing' : 'MusicTrackCardFailed')}
        </p>
      )}
      <PvModuleOff
        isOpen={gate.isAsked}
        module="music"
        hint={lang('ModuleOffHintTrack')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </div>
  );
};

export default memo(MusicTrackCard);
