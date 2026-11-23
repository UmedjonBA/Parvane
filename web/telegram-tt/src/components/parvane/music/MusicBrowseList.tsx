import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicData from './useMusicData';
import useMusicPages from './useMusicPages';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCatalogRow from './MusicCatalogRow';
import MusicLoadMore from './MusicLoadMore';
import MusicPlayButtons from './MusicPlayButtons';
import MusicSectionHead from './MusicSectionHead';
import MusicTrackRow from './MusicTrackRow';

import styles from './Music.module.scss';

type OwnProps = {
  // Жанр библиотеки (`genre`) либо «Чарт каталога» (без жанра)
  genre?: string;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

const PAGE = 50;

// Parvane (макет «Музыки» 23 ноя, доска `MusicSearch-01`, «Обзор»): плитка жанра открывает его треки на сервере
// страницами, «Чарт каталога» — популярное в каталоге строками каталога (что уже на сервере — строкой сервера)
const MusicBrowseList = ({ genre, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const pages = useMusicPages<MusicTrack>(genre !== undefined ? `genre:${genre}` : undefined, async (offset) => {
    const items = await callGenre(genre!, offset);
    return { items, hasMore: items.length >= PAGE };
  });
  const { data: chart, isFailed } = useMusicData(genre === undefined ? 'catalog-chart' : undefined, () => (
    callChart()
  ));

  const tracks = pages.items || [];
  const source = { kind: 'search' as const, name: genre || lang('MusicCatalogChart') };
  const handlePlay = useLastCallback((index: number) => playTracks(tracks, index, { source }));
  const handlePlayAll = useLastCallback(() => playTracks(tracks, 0, { source }));
  const handleShuffle = useLastCallback(() => playTracks(tracks, 0, { isShuffled: true, source }));
  const handleStar = useLastCallback((track: MusicTrack) => void setTrackStarred(track, !track.isStarred));

  function renderGenre() {
    if (!pages.isLoaded) return <PvSkeleton />;
    if (pages.isFailed && !tracks.length) return <PvEmpty text={lang('MusicLoadFailed')} />;
    if (!tracks.length) return <PvEmpty text={lang('MusicEmpty')} data-music-empty />;
    return (
      <>
        <ul className={styles.tracks} data-music-tracks>
          {tracks.map((track, index) => (
            <MusicTrackRow
              key={track.id}
              track={track}
              index={index}
              isCurrent={track.id === current?.id}
              isPlaying={player.isPlaying}
              canQueue
              canSaveOffline
              onPlay={handlePlay}
              onStar={handleStar}
              onSendToChat={onSendToChat}
            />
          ))}
        </ul>
        {pages.hasMore && <MusicLoadMore onMore={pages.loadMore} />}
      </>
    );
  }

  function renderChart() {
    if (!chart) return isFailed ? <PvEmpty text={lang('MusicCatalogDown')} /> : <PvSkeleton />;
    return (
      <ul className={styles.tracks} data-music-tracks>
        {chart.map((track, index) => (
          <MusicCatalogRow key={track.ref || `${track.artist}:${track.title}`} track={track} rank={index + 1} />
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.view} data-music-browse={genre === undefined ? 'chart' : 'genre'}>
      <MusicSectionHead
        title={genre || lang('MusicCatalogChart')}
        subtitle={genre === undefined ? lang('MusicCatalogChartSub') : undefined}
        actions={genre !== undefined && tracks.length ? (
          <MusicPlayButtons onPlay={handlePlayAll} onShuffle={handleShuffle} />
        ) : undefined}
        isPhone={isPhone}
        onBack={goBackMusic}
      />
      {genre !== undefined ? renderGenre() : renderChart()}
    </div>
  );
};

function callGenre(name: string, offset: number) {
  return callMusic('parvaneMusicGenre', { name, offset });
}

function callChart() {
  return callMusic('parvaneMusicCatalogChart');
}

export default memo(MusicBrowseList);
