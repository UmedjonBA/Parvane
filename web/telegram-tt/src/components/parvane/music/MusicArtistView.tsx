import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSkeleton from '../notes/PvSkeleton';
import MusicAlbumTiles from './MusicAlbumTiles';
import { loadArtistTracks } from './MusicBrowseView';
import MusicCover from './MusicCover';
import MusicPlayButtons from './MusicPlayButtons';
import MusicSectionHead from './MusicSectionHead';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  artistId: string;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

const COVER_PHONE = 64;
const COVER_DESK = 72;

// Parvane (spec 041, доски `XpMusic`, `XdMusic`): страница исполнителя — круглый портрет, «N альбомов · M треков на
// сервере», «Играть всё / Вперемешку» (треки всех альбомов), альбомы полосой с подписью «год · N треков», синглы
// одной плиткой, «Популярное на сервере» по прослушиваниям всех
const MusicArtistView = ({ artistId, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const { data, isFailed, patch } = useMusicData(artistId, () => callMusic('parvaneMusicArtist', { artistId }));

  const source = { kind: 'artist' as const, name: data?.artist?.name };
  const playAll = useLastCallback(async (isShuffled?: boolean) => {
    const tracks = await loadArtistTracks(data?.albums || []);
    playTracks(tracks, 0, { isShuffled, source });
  });
  const handlePlayAll = useLastCallback(() => void playAll());
  const handleShuffle = useLastCallback(() => void playAll(true));
  const handlePlayPopular = useLastCallback((index: number) => playTracks(data!.popular, index, { source }));
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous, popular: previous.popular.map((item) => (item.id === track.id ? { ...item, isStarred } : item)),
    }));
    void setTrackStarred(track, isStarred);
  });

  if (isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
  if (!data) return <PvSkeleton />;

  const albums = data.albums.filter((album) => !album.isSingle);
  const singles = data.albums.filter((album) => album.isSingle);
  const singleTracks = singles.reduce((sum, album) => sum + album.trackCount, 0);
  const trackCount = data.albums.reduce((sum, album) => sum + album.trackCount, 0);
  const name = data.artist?.name || '';

  return (
    <div className={styles.view} data-music-artist={artistId}>
      <MusicSectionHead
        title={name}
        barTitle={lang('MusicKindArtist')}
        kicker={isPhone ? undefined : lang('MusicKindArtist')}
        cover={(
          <MusicCover
            coverId={data.artist?.coverId}
            toneId={artistId}
            size={isPhone ? COVER_PHONE : COVER_DESK}
            glyph="mic"
            isRound
            className={isPhone ? styles.heroCoverSmall : styles.heroCover}
          />
        )}
        subtitle={lang('MusicArtistFacts', {
          albums: lang('MusicAlbumsCount', { count: data.albums.length }, { pluralValue: data.albums.length }),
          tracks: lang('MusicTracksCount', { count: trackCount }, { pluralValue: trackCount }),
        })}
        isPhone={isPhone}
        actions={(
          <MusicPlayButtons
            playKey="MusicPlayEverything"
            isDisabled={!data.albums.length}
            onPlay={handlePlayAll}
            onShuffle={handleShuffle}
          />
        )}
        onBack={goBackMusic}
      />
      {(Boolean(albums.length) || Boolean(singles.length)) && (
        <>
          <div className={kit.caps}>{lang('MusicAlbums')}</div>
          <MusicAlbumTiles
            albums={albums}
            caption="year"
            isRow
            singles={singles.length ? { artistId, trackCount: singleTracks } : undefined}
          />
        </>
      )}
      {Boolean(data.popular.length) && (
        <>
          <div className={kit.caps}>{lang('MusicPopularOnServer')}</div>
          <ul className={styles.tracks} data-music-popular>
            {data.popular.map((track, index) => (
              <MusicTrackRow
                key={track.id}
                track={track}
                index={index}
                number={index + 1}
                columns={isPhone ? undefined : ['album']}
                isAlbumLine
                isCurrent={track.id === current?.id}
                isPlaying={player.isPlaying}
                canQueue
                canSaveOffline
                onPlay={handlePlayPopular}
                onStar={handleStar}
                onSendToChat={onSendToChat}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

export default memo(MusicArtistView);
