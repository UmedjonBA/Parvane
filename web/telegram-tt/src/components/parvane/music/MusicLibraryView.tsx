import { memo, useState } from '../../../lib/teact/teact';

import type { MusicAlbum, MusicArtist, MusicInfo } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';

import buildClassName from '../../../util/buildClassName';
import { callMusic } from './musicPlayer';
import { openMusicView, openNewPlaylist } from './musicView';
import useMusicPages from './useMusicPages';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicLibraryItems from './MusicLibraryItems';
import MusicLoadMore from './MusicLoadMore';
import MusicMenu from './MusicMenu';

import sheets from '../cloud/CloudSheets.module.scss';
import styles from './MusicLibrary.module.scss';

type OwnProps = {
  info: MusicInfo;
};

type Tab = 'playlists' | 'albums' | 'artists';
type AlbumSort = 'recent' | 'name';

const TABS: Tab[] = ['playlists', 'albums', 'artists'];
const TAB_KEYS = { playlists: 'MusicPlaylists', albums: 'MusicAlbums', artists: 'MusicArtists' } as const;
const PAGE = 50;

// Parvane (макет «Музыки» 23 ноя, доска `MusicLibrary`): вкладка «Медиатека» телефона — чипы «Плейлисты ·
// Альбомы · Исполнители» и «…» (сортировка, сетка, «Не нравится», корзина, настройки). Плейлисты — общим списком
// медиатеки, альбомы — сеткой по три, исполнители — кругами с числом треков
const MusicLibraryView = ({ info }: OwnProps) => {
  const lang = useLang();
  // Ни один чип не выбран — вся медиатека списком (доска `MusicLibrary-01`); повторное нажатие снимает выбор
  const [tab, setTab] = useState<Tab>();
  const [albumSort, setAlbumSort] = useState<AlbumSort>('recent');
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const albums = useMusicPages<MusicAlbum>(tab === 'albums' ? `lib-albums:${albumSort}` : undefined, async (offset) => {
    const items = albumSort === 'recent'
      ? await callMusic('parvaneMusicRecent', { offset })
      : (await callMusic('parvaneMusicSearch', { query: '', offset })).albums;
    return { items, hasMore: items.length >= PAGE };
  });
  const artists = useMusicPages<MusicArtist>(tab === 'artists' ? 'lib-artists' : undefined, async (offset) => {
    const page = await callMusic('parvaneMusicSearch', { query: '', offset });
    return { items: page.artists, hasMore: page.artists.length >= PAGE };
  });

  const handleTab = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const value = e.currentTarget.dataset.tab as Tab;
    setTab(value === tab ? undefined : value);
  });
  const handleOpenMenu = useLastCallback(() => setIsMenuOpen(true));
  const handleCloseMenu = useLastCallback(() => setIsMenuOpen(false));
  const handlePick = useLastCallback((key: string) => {
    setIsMenuOpen(false);
    if (key === 'sort') setAlbumSort(albumSort === 'recent' ? 'name' : 'recent');
    else if (key === 'newPlaylist') openNewPlaylist();
    else if (key === 'dislikes') openMusicView({ kind: 'dislikes' });
    else if (key === 'trash') openMusicView({ kind: 'trash' });
    else if (key === 'settings') openMusicView({ kind: 'settings' });
  });
  const handleOpenAlbum = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'album', id: e.currentTarget.dataset.id! });
  });
  const handleOpenArtist = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'artist', id: e.currentTarget.dataset.id! });
  });

  const sortName = lang(albumSort === 'recent' ? 'MusicSortRecentlyAdded' : 'MusicSortByName');
  const icon = (name: ParvaneIconName) => <ParvaneIcon name={name} className={sheets.menuIcon} />;

  function renderAlbums() {
    if (!albums.items) return albums.isFailed ? renderFailed(albums.reload) : <PvSkeleton />;
    return (
      <>
        <div className={styles.grid} data-music-library-albums>
          {albums.items.map((album) => (
            <button
              key={album.id}
              type="button"
              className={styles.gridItem}
              data-id={album.id}
              data-album={album.id}
              onClick={handleOpenAlbum}
            >
              <MusicCover
                coverId={album.coverId}
                toneId={album.id}
                size={100}
                glyph="disc"
                className={styles.gridCover}
              />
              <span className={styles.gridTitle}>{album.title}</span>
              <span className={styles.gridSub}>
                {[album.artist, album.isSingle ? lang('MusicKindSingle') : undefined].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
        {albums.hasMore && <MusicLoadMore onMore={albums.loadMore} />}
      </>
    );
  }

  function renderArtists() {
    if (!artists.items) return artists.isFailed ? renderFailed(artists.reload) : <PvSkeleton />;
    return (
      <>
        <div className={styles.list} data-music-library-artists>
          {artists.items.map((artist) => (
            <button
              key={artist.id}
              type="button"
              className={styles.row}
              data-id={artist.id}
              data-artist={artist.id}
              onClick={handleOpenArtist}
            >
              <MusicCover
                coverId={artist.coverId}
                toneId={artist.id}
                size={46}
                glyph="mic"
                isRound
                className={styles.rowCover}
              />
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{artist.name}</span>
                <span className={styles.rowSub}>
                  {lang('MusicTracksCount', { count: artist.trackCount }, { pluralValue: artist.trackCount })}
                </span>
              </span>
            </button>
          ))}
        </div>
        {artists.hasMore && <MusicLoadMore onMore={artists.loadMore} />}
      </>
    );
  }

  function renderFailed(onRetry: NoneToVoidFunction) {
    return (
      <div className={styles.failed} role="alert">
        {lang('MusicLoadFailed')}
        <button type="button" className={styles.retry} onClick={onRetry}>{lang('MusicRetry')}</button>
      </div>
    );
  }

  return (
    <div className={styles.root} data-music-library>
      <div className={styles.chips} role="tablist" aria-label={lang('MusicLibrary')}>
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={buildClassName(styles.chip, tab === value && styles.chipOn)}
            data-tab={value}
            onClick={handleTab}
          >
            {lang(TAB_KEYS[value])}
          </button>
        ))}
        <button
          type="button"
          className={styles.more}
          aria-label={lang('MusicLibraryMore')}
          data-music-library-more
          onClick={handleOpenMenu}
        >
          <ParvaneIcon name="dotsH" isSmall />
        </button>
      </div>
      {(!tab || tab === 'playlists') && <MusicLibraryItems info={info} isPhone />}
      {tab === 'albums' && renderAlbums()}
      {tab === 'artists' && renderArtists()}
      {isMenuOpen && (
        <MusicMenu
          title={lang('MusicLibrary')}
          actions={[
            {
              key: 'sort',
              title: lang('MusicSortBy', { name: sortName }),
              glyph: icon('sort'),
            },
            { key: 'newPlaylist', title: lang('MusicPlaylistNew'), glyph: icon('plus') },
            { key: 'dislikes', title: lang('MusicDislikes'), glyph: icon('ban') },
            { key: 'trash', title: lang('MusicTrash'), glyph: icon('trash') },
            { key: 'settings', title: lang('MusicSettings'), glyph: icon('gear') },
          ]}
          onPick={handlePick}
          onClose={handleCloseMenu}
        />
      )}
    </div>
  );
};

export default memo(MusicLibraryView);
