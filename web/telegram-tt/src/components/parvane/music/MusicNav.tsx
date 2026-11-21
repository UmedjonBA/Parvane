import { memo } from '../../../lib/teact/teact';

import type { MusicInfo } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { MusicView, MusicViewKind } from './musicView';

import buildClassName from '../../../util/buildClassName';
import { getOfflineState } from './musicOffline';
import { getPlaylists } from './musicPlaylists';
import { openMusicView, openNewPlaylist } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicSharedNavItems from './shared/MusicSharedNavItems';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  view: MusicView;
  info: MusicInfo;
};

type Item = {
  kind: MusicViewKind;
  icon: ParvaneIconName;
  titleKey: 'MusicHome' | 'MusicSearch' | 'MusicStarred' | 'MusicArtists' | 'MusicAlbums' | 'MusicOffline'
    | 'MusicAdded';
  tone?: string;
};

const TOP: Item[] = [
  { kind: 'home', icon: 'home', titleKey: 'MusicHome', tone: styles.navToneAccent },
  { kind: 'search', icon: 'search', titleKey: 'MusicSearch' },
];
const LIBRARY: Item[] = [
  { kind: 'starred', icon: 'heart', titleKey: 'MusicStarred', tone: styles.navToneRed },
  { kind: 'artists', icon: 'mic', titleKey: 'MusicArtists', tone: styles.navTonePurple },
  { kind: 'albums', icon: 'disc', titleKey: 'MusicAlbums', tone: styles.navToneGreen },
  { kind: 'offline', icon: 'downloaded', titleKey: 'MusicOffline', tone: styles.navToneAqua },
];
// Страница альбома и исполнителя подсвечивает свой раздел (доска `XdMusic`)
const OWNER_OF: Partial<Record<MusicViewKind, MusicViewKind>> = {
  artist: 'artists', singles: 'artists', album: 'albums',
};

// Parvane (spec 041, доски `DeskMusic`, `DeskMusicMore`, `ZdMusicX`): навигация «Музыки» на компьютере — главная и
// поиск, группа «Библиотека» со счётчиками, группа «Плейлисты» самими плейлистами с числом треков
const MusicNav = ({ view, info }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const offline = useDerivedState(getOfflineState);
  const selected = OWNER_OF[view.kind] || view.kind;
  const selectedPlaylist = view.kind === 'playlist' ? view.id : undefined;
  // Пустая библиотека — без счётчиков (доска `ZdMusicX`, «Пустая библиотека»)
  const isEmptyLibrary = !info.libraryTracks;
  const counts: Partial<Record<MusicViewKind, number>> = isEmptyLibrary ? {} : {
    starred: info.starredCount,
    artists: info.libraryArtists,
    albums: info.libraryAlbums,
    offline: offline.entries.length,
  };

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { view: kind, playlist } = e.currentTarget.dataset;
    if (playlist) openMusicView({ kind: 'playlist', id: playlist }, true);
    else openMusicView({ kind: kind as 'home' }, true);
  });

  const handleNewPlaylist = useLastCallback(() => openNewPlaylist());

  function renderItem(item: Item) {
    const isOn = selected === item.kind;
    const count = counts[item.kind];
    return (
      <button
        key={item.kind}
        type="button"
        className={buildClassName(styles.navItem, isOn && styles.navItemOn)}
        aria-current={isOn ? 'page' : undefined}
        data-view={item.kind}
        onClick={handleOpen}
      >
        <ParvaneIcon name={item.icon} isSmall className={item.tone} />
        <span className={styles.navLabel}>{lang(item.titleKey)}</span>
        {Boolean(count) && <span className={buildClassName(kit.mono, kit.muted, styles.navCount)}>{count}</span>}
      </button>
    );
  }

  return (
    <nav className={styles.nav} aria-label={lang('ParvaneModuleMusic')} data-music-nav>
      {TOP.map(renderItem)}
      <div className={buildClassName(kit.caps, styles.navGroup)}>{lang('MusicLibrary')}</div>
      {LIBRARY.map(renderItem)}
      {info.isFetchEnabled && renderItem({ kind: 'added', icon: 'upload', titleKey: 'MusicAdded' })}
      <div className={buildClassName(kit.caps, styles.navGroup)}>
        <span className={kit.grow}>{lang('MusicPlaylists')}</span>
        <button
          type="button"
          className={styles.navAdd}
          aria-label={lang('MusicPlaylistNew')}
          data-music-new-playlist
          onClick={handleNewPlaylist}
        >
          <ParvaneIcon name="plus" isSmall />
        </button>
      </div>
      {!isEmptyLibrary && playlists.map((playlist) => {
        const isOn = playlist.id === selectedPlaylist;
        return (
          <button
            key={playlist.id}
            type="button"
            className={buildClassName(styles.navItem, isOn && styles.navItemOn)}
            aria-current={isOn ? 'page' : undefined}
            data-playlist={playlist.id}
            onClick={handleOpen}
          >
            <ParvaneIcon name="list" isSmall />
            <span className={styles.navLabel}>{playlist.name}</span>
            <span className={buildClassName(kit.mono, kit.muted, styles.navCount)}>{playlist.count}</span>
          </button>
        );
      })}
      <MusicSharedNavItems selectedId={view.kind === 'shared' ? view.id : undefined} />
    </nav>
  );
};

export default memo(MusicNav);
