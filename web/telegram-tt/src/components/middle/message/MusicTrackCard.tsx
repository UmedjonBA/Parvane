import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicCatalogTrack, MusicTrack } from '../../../api/parvane/musicApi';
import type { ApiMusicTrackCard } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { startFetch } from '../../parvane/music/fetch/musicFetch';
import { formatTrackTime } from '../../parvane/music/musicFormat';
import {
  callMusic, catalogPreviewTrack, getMusicInfo, loadMusicInfo, playTracks,
} from '../../parvane/music/musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import Icon from '../../common/icons/Icon';
import MusicCover from '../../parvane/music/MusicCover';
import MusicOfflineButton from '../../parvane/music/MusicOfflineButton';
import PvModuleOff from '../../parvane/notes/PvModuleOff';

import styles from './MusicTrackCard.module.scss';

type OwnProps = {
  track: ApiMusicTrackCard;
};

// Parvane (TRACK-1): трек «Музыки» в чате — карточка с названием и исполнителем. Играет из библиотеки своего
// сервера: байтов трека в сообщении нет. Трек чужого сервера либо убранный из библиотеки только показывается
const MusicTrackCard = ({ track }: OwnProps) => {
  const { showNotification } = getActions();
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
      playTracks(found, 0, { source: { kind: 'chat' } });
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

  // Трек каталога (доска `MusicChat-01`): «Слушать из сети» — отрывок каталога, «Добавить на сервер» — скачать
  const catalogTrack = useMemo<MusicCatalogTrack | undefined>(() => (track.catalogRef ? {
    artist: track.artist,
    title: track.title,
    album: track.album || '',
    durationSecs: track.durationSecs,
    year: 0,
    ref: track.catalogRef,
    coverUrl: track.coverUrl,
    previewUrl: track.previewUrl,
  } : undefined), [track]);
  const handleListenCatalog = useLastCallback(() => {
    if (catalogTrack?.previewUrl) playTracks([catalogPreviewTrack(catalogTrack)], 0, { source: { kind: 'chat' } });
  });
  const handleAddCatalog = useLastCallback(async () => {
    if (!catalogTrack) return;
    const result = await startFetch(catalogTrack);
    const key = result === 'ok' ? 'MusicFetchStarted'
      : result === 'limit' ? 'MusicFetchLimit' : 'MusicFetchFailedShort';
    showNotification({ message: lang(key) });
  });
  const isCatalog = Boolean(catalogTrack);
  const canListenCatalog = Boolean(isCatalog && catalogTrack?.previewUrl && info?.isEnabled && isMusicOn);
  const canAddCatalog = Boolean(isCatalog && info?.isFetchEnabled && isMusicOn);
  const isPlayable = isCatalog ? canListenCatalog : canPlay || gate.canEnable;

  return (
    <div
      className={styles.root}
      data-music-track-card={track.trackId || track.catalogRef}
      data-music-catalog-card={isCatalog || undefined}
    >
      <div className={styles.head}>
        <MusicCover
          coverUrl={track.coverUrl}
          toneId={track.trackId || track.catalogRef || track.title}
          size={52}
          className={buildClassName(styles.cover, isCatalog && styles.coverCatalog)}
        />
        <div className={styles.titles}>
          <div className={styles.title}>{track.title}</div>
          <div className={styles.artist}>
            {isCatalog && <span className={styles.tag}>{lang('MusicInCatalogShort')}</span>}
            {[track.artist, !isCatalog && track.durationSecs ? formatTrackTime(track.durationSecs) : undefined]
              .filter(Boolean).join(' · ')}
          </div>
        </div>
        {canPlay && !isCatalog && <MusicOfflineButton track={offlineTrack} />}
        {isPlayable ? (
          <button
            type="button"
            className={styles.play}
            aria-label={lang('MusicTrackCardPlay')}
            onClick={isCatalog ? handleListenCatalog : handlePlayClick}
          >
            <Icon name="play" />
          </button>
        ) : (
          <span className={buildClassName(styles.play, styles.playOff)} aria-hidden>
            <Icon name="play" />
          </span>
        )}
      </div>
      {isCatalog && (canListenCatalog || canAddCatalog) && (
        <div className={styles.actions}>
          {canListenCatalog && (
            <button type="button" className={styles.action} onClick={handleListenCatalog}>
              {lang('MusicListenFromWeb')}
            </button>
          )}
          {canAddCatalog && (
            <button type="button" className={styles.action} data-music-card-add onClick={handleAddCatalog}>
              {lang('MusicAddToServer')}
            </button>
          )}
        </div>
      )}
      {isOwnServer === false && !isCatalog && (
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
