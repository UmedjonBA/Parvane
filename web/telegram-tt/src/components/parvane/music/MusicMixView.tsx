import {
  memo, useEffect, useMemo,
} from '../../../lib/teact/teact';

import type {
  MusicCatalogTrack, MusicTrack,
} from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from './musicFormat';
import {
  getIsMusicMixFailed, getMusicMix, loadMusicMix, openMixSettings, rebuildMusicMix,
} from './musicMix';
import {
  catalogNetworkTrack, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic, openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCatalogRow from './MusicCatalogRow';
import MusicSectionHead from './MusicSectionHead';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

// «Микс дня» (как в HomeMusic): 25 треков на сегодня из библиотеки сервера и похожего из каталога. «Слушать» играет
// треки библиотеки; трек каталога — «Найти и скачать» (послушать до скачивания — следующим шагом). «Другой микс»
// собирает заново; настройки — режим, час обновления, любимые исполнители
const MusicMixView = ({ isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const today = useDerivedState(getMusicMix);
  const isFailed = useDerivedState(getIsMusicMixFailed);
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);

  useEffect(() => {
    void loadMusicMix();
  }, []);

  const mix = today?.mix;
  // Микс играет целиком: трек сервера — с сервера, трек каталога — потоком из сети (не отрывок)
  const playable = useMemo(() => (mix?.tracks || [])
    .map((row) => row.track || (row.catalog ? catalogNetworkTrack(row.catalog) : undefined))
    .filter(Boolean), [mix]);

  const handlePlay = useLastCallback((index: number) => {
    playTracks(playable, index, { source: { kind: 'home' } });
  });
  const handlePlayAll = useLastCallback(() => handlePlay(0));
  const handleAnother = useLastCallback(() => void rebuildMusicMix());
  const handleArtists = useLastCallback(() => openMusicView({ kind: 'mixArtists' }));
  const handleStar = useLastCallback((track: MusicTrack) => void setTrackStarred(track, !track.isStarred));
  const handleRetry = useLastCallback(() => void loadMusicMix());

  if (today?.needsArtists) {
    return (
      <div className={styles.view} data-music-mix-view="pick">
        <MusicSectionHead
          title={lang('MusicMixTitle')}
          isPhone={isPhone}
          barTitle={lang('MusicMixTitle')}
          onBack={goBackMusic}
        />
        <PvEmpty
          title={lang('MusicMixPickArtists')}
          text={lang('MusicMixPickHint')}
          actionText={lang('MusicMixPickArtists')}
          onAction={handleArtists}
        />
      </div>
    );
  }

  const next = mix ? new Date(mix.nextMs) : undefined;
  const nextText = next ? next.toLocaleString(lang.code, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className={styles.view} data-music-mix-view={today?.isBuilding ? 'building' : 'ready'}>
      <MusicSectionHead
        title={lang('MusicMixTitle')}
        kicker={today?.isBuilding ? lang('MusicMixBuilding') : undefined}
        subtitle={mix ? [
          lang('MusicTracksCount', { count: mix.tracks.length }, { pluralValue: mix.tracks.length }),
          lang('MusicMixNext', { when: nextText }),
        ].join(' · ') : undefined}
        cover={(
          <span className={styles.mixCover} aria-hidden>
            <ParvaneIcon name="music" />
          </span>
        )}
        actions={(
          <>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              disabled={!playable.length}
              data-music-mix-play
              onClick={handlePlayAll}
            >
              <ParvaneIcon name="play" isSmall />
              {lang('MusicListen')}
            </button>
            <button
              type="button"
              className={kit.btn}
              disabled={today?.isBuilding}
              data-music-mix-another
              onClick={handleAnother}
            >
              {lang('MusicMixAnother')}
            </button>
            <button type="button" className={kit.btn} data-music-mix-settings-open onClick={openMixSettings}>
              {lang('MusicMixSettings')}
            </button>
          </>
        )}
        isPhone={isPhone}
        barTitle={lang('MusicMixTitle')}
        onBack={goBackMusic}
      />
      {isFailed && !mix && (
        <PvEmpty text={lang('MusicMixFailed')} actionText={lang('MusicFetchRetry')} onAction={handleRetry} />
      )}
      {!mix && !isFailed && <PvSkeleton />}
      {mix && (
        <ul className={styles.tracks} data-music-mix-tracks>
          {mix.tracks.map((row, index) => {
            if (row.track) {
              return (
                <MusicTrackRow
                  key={`lib:${row.track.id}`}
                  track={row.track}
                  index={index}
                  isCurrent={row.track.id === current?.id}
                  isPlaying={player.isPlaying}
                  trailing="offline"
                  canQueue
                  canSaveOffline
                  onPlay={handlePlay}
                  onStar={handleStar}
                  onSendToChat={onSendToChat}
                />
              );
            }
            const catalog = row.catalog!;
            return (
              <MusicCatalogRow
                key={`cat:${catalogKey(catalog)}`}
                track={catalog}
                sub={catalogLine(catalog, row.becauseOf ? lang('MusicMixBecause', { name: row.becauseOf }) : '')}
                mixTag={catalog.title}
                onListen={() => handlePlay(index)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
};

// Вторая строка трека каталога: исполнитель, «похоже на …», длительность
function catalogLine(track: MusicCatalogTrack, because: string) {
  return [track.artist, because, formatTrackTime(track.durationSecs)].filter(Boolean).join(' · ');
}

function catalogKey(track: MusicCatalogTrack) {
  return track.ref || `${track.artist}|${track.title}`;
}

export default memo(MusicMixView);
