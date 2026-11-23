import { memo, useEffect } from '../../../lib/teact/teact';

import type { MusicInfo, MusicTrack } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { MusicView } from './musicView';

import buildClassName from '../../../util/buildClassName';
import { getSharedPlaylists } from './shared/musicShared';
import { getIsMusicMixFailed, getMusicMix, loadMusicMix } from './musicMix';
import {
  callMusic, getCurrentTrack, getMusicPlayer, loadMusicInfo, playTracks, setTrackStarred,
} from './musicPlayer';
import { getPlaylists } from './musicPlaylists';
import { openMusicView, requestMusicAdd } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicTrackRow from './MusicTrackRow';

import styles from './MusicHome.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

type Tile = {
  key: string;
  view: MusicView;
  title: string;
  glyph: ParvaneIconName;
  toneId: string;
};

// Плиток быстрого доступа на телефоне — 2 × 3 (доска `MusicHome`)
const QUICK_TILES = 6;
const POPULAR_ROWS = 5;

// Parvane (макет «Музыки» 23 ноя, доски `MusicHome`, `DeskMusic`): главная — плитки быстрого доступа (телефон),
// «Сделано для вас» (микс дня), «Новое на сервере» альбомами, «Популярное на сервере» за неделю с номерами,
// «Частое у вас» кругами исполнителей. Пустой сервер — приглашение найти в каталоге, вставить ссылку, загрузить файл
const MusicHomeView = ({ info, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const playlists = useDerivedState(getPlaylists);
  const shared = useDerivedState(getSharedPlaylists);
  const mixToday = useDerivedState(getMusicMix);
  const isMixFailed = useDerivedState(getIsMusicMixFailed);
  const current = getCurrentTrack(player);
  const { data, isFailed, reload, patch } = useMusicData('home', () => callMusic('parvaneMusicHome'));

  useEffect(() => {
    void loadMusicMix();
  }, []);

  const mixTracks = mixToday?.mix?.tracks || [];
  const mixState = mixToday?.needsArtists ? 'pick' : mixToday?.mix && !mixToday.isBuilding ? 'ready'
    : isMixFailed ? 'failed' : 'building';
  const popular = data?.popular.slice(0, POPULAR_ROWS) || [];
  const popularTracks = popular.map((item) => item.track);

  // Плитки быстрого доступа (телефон): «Любимое», микс, свои и общие плейлисты
  const tiles: Tile[] = [
    { key: 'starred', view: { kind: 'starred' }, title: lang('MusicStarred'), glyph: 'heart', toneId: 'starred' },
  ];
  if (mixTracks.length) {
    tiles.push({ key: 'mix', view: { kind: 'mix' }, title: lang('MusicMixTitle'), glyph: 'wave', toneId: 'mix' });
  }
  playlists.forEach((playlist) => tiles.push({
    key: `playlist:${playlist.id}`,
    view: { kind: 'playlist', id: playlist.id },
    title: playlist.name,
    glyph: 'list',
    toneId: playlist.id,
  }));
  shared.forEach((playlist) => tiles.push({
    key: `shared:${playlist.id}`,
    view: { kind: 'shared', id: playlist.id },
    title: playlist.name,
    glyph: 'users',
    toneId: playlist.id,
  }));
  const quickTiles = tiles.slice(0, QUICK_TILES);

  const handleOpenTile = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const tile = tiles.find((item) => item.key === e.currentTarget.dataset.tile);
    if (tile) openMusicView(tile.view);
  });
  const handleOpenMix = useLastCallback(() => openMusicView({ kind: mixState === 'pick' ? 'mixArtists' : 'mix' }));
  const handleOpenAlbum = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'album', id: e.currentTarget.dataset.id! });
  });
  const handleOpenArtist = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'artist', id: e.currentTarget.dataset.id! });
  });
  const handleAllAlbums = useLastCallback(() => openMusicView({ kind: 'albums' }));
  const handlePlayPopular = useLastCallback((index: number) => {
    playTracks(popularTracks, index, { source: { kind: 'home' } });
  });
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous,
      popular: previous.popular.map((item) => (
        item.track.id === track.id ? { ...item, track: { ...item.track, isStarred } } : item
      )),
    }));
    void setTrackStarred(track, isStarred);
  });
  const handleFind = useLastCallback(() => requestMusicAdd('fetch'));
  const handleLink = useLastCallback(() => requestMusicAdd('link'));
  const handleFile = useLastCallback(() => requestMusicAdd('file'));
  const handleRetry = useLastCallback(() => {
    void loadMusicInfo();
    reload();
  });

  if (isFailed && !data) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
  if (!data) return <PvSkeleton onRetry={handleRetry} />;

  // Пустой сервер (доска `MusicHome`, «На сервере пока нет музыки»)
  if (!info.libraryTracks && !data.fresh.length) {
    const canFetch = info.isFetchEnabled;
    return (
      <section className={styles.empty} data-music-empty="library">
        <span className={styles.emptyRing} aria-hidden>
          <ParvaneIcon name="music" />
        </span>
        <h2 className={styles.emptyTitle}>{lang('MusicEmptyTitle')}</h2>
        <p className={styles.emptyText}>{lang(canFetch ? 'MusicEmptyText' : 'MusicEmptyFetchOff')}</p>
        {canFetch && (
          <button type="button" className={styles.emptyPrimary} data-music-empty-find onClick={handleFind}>
            <ParvaneIcon name="search" isSmall />
            {lang('MusicFindInCatalog')}
          </button>
        )}
        <div className={styles.emptyRow}>
          {canFetch && (
            <button type="button" className={styles.emptySecondary} onClick={handleLink}>
              <ParvaneIcon name="link" isSmall />
              {lang('MusicLinkShort')}
            </button>
          )}
          {info.isUploadEnabled && (
            <button type="button" className={styles.emptySecondary} onClick={handleFile}>
              <ParvaneIcon name="upload" isSmall />
              {lang('MusicOwnFile')}
            </button>
          )}
        </div>
        <p className={styles.emptyNote}>{lang('MusicEmptyMixNote')}</p>
      </section>
    );
  }

  function renderSectionHead(title: string, onAll?: NoneToVoidFunction, sub?: string) {
    return (
      <>
        <div className={styles.head}>
          <h2 className={styles.headTitle}>{title}</h2>
          {onAll && (
            <button type="button" className={styles.headAll} onClick={onAll}>
              {lang(isPhone ? 'MusicAll' : 'MusicShowAll')}
            </button>
          )}
        </div>
        {sub && <div className={styles.headSub}>{sub}</div>}
      </>
    );
  }

  function renderMixCard() {
    const mixArtists = [...new Set(mixTracks.map((row) => row.track?.artist || row.catalog?.artist).filter(Boolean))];
    const sub = mixState === 'pick' ? lang('MusicMixPickArtists')
      : mixState === 'failed' ? lang('MusicMixFailed')
        : mixState === 'building' ? lang('MusicMixBuilding')
          : mixArtists.slice(0, 3).join(', ');
    return (
      <button type="button" className={styles.card} data-music-mix={mixState} onClick={handleOpenMix}>
        <span className={buildClassName(styles.cardArt, styles.mixArt)}>
          <ParvaneIcon name="wave" className={styles.mixGlyph} />
          {isPhone && <span className={styles.mixName}>{lang('MusicMixTitle')}</span>}
        </span>
        {!isPhone && <span className={styles.cardTitle}>{lang('MusicMixTitle')}</span>}
        <span className={styles.cardSub}>{sub}</span>
      </button>
    );
  }

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-home>
      {isPhone && Boolean(quickTiles.length) && (
        <div className={styles.quick} data-music-quick>
          {quickTiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              className={styles.quickTile}
              data-tile={tile.key}
              onClick={handleOpenTile}
            >
              <MusicCover toneId={tile.toneId} size={56} glyph={tile.glyph} className={styles.quickCover} />
              <span className={styles.quickTitle}>{tile.title}</span>
            </button>
          ))}
        </div>
      )}

      {renderSectionHead(lang('MusicMadeForYou'))}
      <div className={styles.cards}>{renderMixCard()}</div>

      {Boolean(data.fresh.length) && (
        <>
          {renderSectionHead(lang('MusicNewOnServer'), handleAllAlbums)}
          <div className={styles.cards} data-music-fresh>
            {data.fresh.map((album) => (
              <button
                key={album.id}
                type="button"
                className={styles.card}
                data-id={album.id}
                data-album={album.id}
                onClick={handleOpenAlbum}
              >
                <MusicCover
                  coverId={album.coverId}
                  toneId={album.id}
                  size={isPhone ? 140 : 110}
                  glyph="disc"
                  className={styles.cardArt}
                />
                <span className={styles.cardTitle}>{album.title}</span>
                <span className={styles.cardSub}>{album.artist}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {Boolean(popular.length) && (
        <>
          {renderSectionHead(lang('MusicPopularOnServer'), undefined, isPhone ? lang('MusicPopularWeek') : undefined)}
          <ul className={styles.rows} data-music-popular>
            {popular.map((item, index) => (
              <MusicTrackRow
                key={item.track.id}
                track={item.track}
                index={index}
                rank={index + 1}
                isCurrent={item.track.id === current?.id}
                isPlaying={player.isPlaying}
                note={lang('MusicPlaysWeek', { count: item.playsWeek }, { pluralValue: item.playsWeek })}
                columns={isPhone ? undefined : ['album']}
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

      {Boolean(data.frequentArtists.length) && (
        <>
          {renderSectionHead(lang('MusicFrequent'))}
          <div className={styles.cards} data-music-frequent>
            {data.frequentArtists.map((artist) => (
              <button
                key={artist.id}
                type="button"
                className={buildClassName(styles.card, styles.artistCard)}
                data-id={artist.id}
                onClick={handleOpenArtist}
              >
                <MusicCover
                  coverId={artist.coverId}
                  toneId={artist.id}
                  size={isPhone ? 86 : 110}
                  glyph="mic"
                  isRound
                  className={styles.artistArt}
                />
                <span className={styles.cardTitle}>{artist.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default memo(MusicHomeView);
