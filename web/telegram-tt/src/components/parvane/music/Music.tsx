import {
  memo, useEffect, useLayoutEffect, useState,
} from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicTab, MusicView } from './musicView';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { getParvaneSection, setParvaneNavCovered } from '../../../util/parvaneSection';
import { refreshFetchJobs } from './fetch/musicFetch';
import { refreshOwnAdded } from './musicAdded';
import { startOfflinePlaylistSync } from './musicOfflineSync';
import {
  callMusic, getMusicInfo, loadMusicInfo, restoreMusicQueue,
} from './musicPlayer';
import { refreshPlaylists } from './musicPlaylists';
import {
  consumeMusicAddRequest, getIsMusicPage, getMusicAddRequest, getMusicTab, getMusicView, goBackMusic, openMusicView,
  openNewPlaylist,
} from './musicView';

import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useBrowserOnline from '../../../hooks/window/useBrowserOnline';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvLoading from '../notes/PvLoading';
import PvOfflineBar from '../notes/PvOfflineBar';
import PvSegment from '../notes/PvSegment';
import MusicUploadsView from './fetch/MusicUploadsView';
import MusicAddedView from './MusicAddedView';
import MusicAlbumView from './MusicAlbumView';
import MusicArtistView from './MusicArtistView';
import MusicBrowseView from './MusicBrowseView';
import MusicHomeView from './MusicHomeView';
import MusicLibraryView from './MusicLibraryView';
import MusicMiniPlayer from './MusicMiniPlayer';
import MusicMixArtistsView from './MusicMixArtistsView';
import MusicMixView from './MusicMixView';
import MusicNav from './MusicNav';
import MusicNewPlaylist from './MusicNewPlaylist';
import MusicOffline from './MusicOffline';
import MusicPlaylistList from './MusicPlaylistList';
import MusicPlaylists from './MusicPlaylists';
import MusicQueue from './MusicQueue';
import MusicSearchView from './MusicSearchView';
import MusicSectionHead from './MusicSectionHead';
import MusicSendDialog from './MusicSendDialog';
import MusicStarredView from './MusicStarredView';
import MusicSharedPage from './shared/MusicSharedPage';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

const TABS: MusicTab[] = ['home', 'search', 'library'];
const TAB_KEYS = { home: 'MusicHome', search: 'MusicSearch', library: 'MusicLibrary' } as const;
// Виды, где плейлисты на экране: их контейнер сверяется с сервером часто
const PLAYLIST_VIEWS = new Set(['library', 'playlists', 'playlist']);

// Parvane (spec 039, 041; доски `MusicHome`, `MusicLibrary`, `DeskMusic`): модуль «Музыка» — общая библиотека
// сервера. Компьютер: навигация с группами, счётчиками и плейлистами, в середине вид, на главной справа очередь.
// Телефон: вкладки «Главная / Поиск / Библиотека», разделы и страницы — поверх ленты модулей со своей шапкой,
// мини-плеер внизу. Плеер один на приложение (`musicPlayer.ts`), вид — сигнал `musicView.ts`
const Music = () => {
  const lang = useLang();
  const { isMobile: isPhone } = useAppLayout();
  const section = useDerivedState(getParvaneSection);
  const info = useDerivedState(getMusicInfo);
  const view = useDerivedState(getMusicView);
  const addRequest = useDerivedState(getMusicAddRequest);
  // Трек, который отправляют в чат
  const [sentTrack, setSentTrack] = useState<MusicTrack>();
  // «+ → Найти и скачать»: курсор в поле поиска
  const [searchFocus, setSearchFocus] = useState(0);
  const isShown = section === 'music';
  const isEnabled = info?.isEnabled;
  const isOnline = useBrowserOnline();
  const isPage = isPhone && view.kind !== 'home' && view.kind !== 'library';

  useEffect(() => {
    if (!isShown || info) return;
    void loadMusicInfo().then((fresh) => {
      if (!fresh.isEnabled) return;
      void restoreMusicQueue();
      startOfflinePlaylistSync();
      void refreshPlaylists();
      void refreshOwnAdded();
      // Задачи «Найти и скачать» и свои файлы, начатые до перезагрузки: опрос и уведомление о конце (spec 041)
      if (fresh.isFetchEnabled || fresh.isUploadEnabled) void refreshFetchJobs();
    });
  }, [isShown, info]);

  // «+» модуля: «Найти и скачать» — поиск с курсором в поле, «Новый плейлист» — окно
  useLayoutEffect(() => {
    if (!isShown || !addRequest || !isEnabled) return;
    consumeMusicAddRequest();
    if (addRequest === 'playlist') {
      openNewPlaylist();
      return;
    }
    openMusicView({ kind: 'search' }, true);
    setSearchFocus((previous) => previous + 1);
  }, [isShown, addRequest, isEnabled]);

  // Страница на телефоне закрывает ленту модулей (своя шапка с «назад», внизу — только мини-плеер)
  useLayoutEffect(() => {
    if (!isShown || !isPage) return undefined;
    setParvaneNavCovered(true);
    return () => setParvaneNavCovered(false);
  }, [isShown, isPage]);

  // Escape на странице — «назад» (общая очередь клавиш; модуль скрыт — слушателя нет)
  const hasBack = isShown && (isPage || (!isPhone && getIsMusicPage(view) && view.kind !== 'search'));
  useLayoutEffect(() => (hasBack ? captureEscKeyListener(goBackMusic) : undefined), [hasBack]);

  const isPlaylistsShown = isShown && PLAYLIST_VIEWS.has(view.kind);
  useEffect(() => {
    if (!isPlaylistsShown) return undefined;
    void callMusic('parvaneMusicPlaylistsSetActive', { isActive: true });
    return () => {
      void callMusic('parvaneMusicPlaylistsSetActive', { isActive: false });
    };
  }, [isPlaylistsShown]);

  const handleRetry = useLastCallback(() => {
    void loadMusicInfo();
  });
  const handleTab = useLastCallback((tab: MusicTab) => openMusicView({ kind: tab }, true));
  const handleCloseSend = useLastCallback(() => setSentTrack(undefined));
  const handleNewPlaylist = useLastCallback(() => openNewPlaylist());

  function renderView(current: MusicView) {
    const common = { isPhone, onSendToChat: setSentTrack };
    switch (current.kind) {
      case 'home':
        return <MusicHomeView info={info!} {...common} />;
      case 'search':
        return <MusicSearchView info={info!} focusToken={searchFocus} {...common} />;
      case 'library':
        return <MusicLibraryView info={info!} />;
      case 'starred':
        return <MusicStarredView info={info!} {...common} />;
      case 'artists':
      case 'albums':
        return <MusicBrowseView kind={current.kind} info={info!} isPhone={isPhone} />;
      case 'album':
        return <MusicAlbumView albumId={current.id} info={info!} {...common} />;
      case 'singles':
        return <MusicAlbumView singlesOf={current.id} info={info!} {...common} />;
      case 'artist':
        return <MusicArtistView artistId={current.id} {...common} />;
      case 'playlist':
        return <MusicPlaylists playlistId={current.id} {...common} />;
      case 'offline':
        return <MusicOffline isPhone={isPhone} />;
      case 'added':
        return <MusicAddedView info={info!} {...common} />;
      // spec 041 (исполнитель «musicshared»): общий плейлист и «Загрузки на сервер»
      case 'shared':
        return <MusicSharedPage id={current.id} isPhone={isPhone} />;
      case 'uploads':
        return <MusicUploadsView info={info!} isPhone={isPhone} />;
      case 'mix':
        return <MusicMixView isPhone={isPhone} onSendToChat={setSentTrack} />;
      case 'mixArtists':
        return <MusicMixArtistsView isPhone={isPhone} />;
      case 'playlists':
        return (
          <div className={styles.view}>
            <MusicSectionHead
              title={lang('MusicPlaylists')}
              isPhone={isPhone}
              barActions={(
                <button
                  type="button"
                  className={kit.ib}
                  aria-label={lang('MusicPlaylistNew')}
                  data-music-new-playlist
                  onClick={handleNewPlaylist}
                >
                  <ParvaneIcon name="plus" />
                </button>
              )}
              onBack={goBackMusic}
            />
            <MusicPlaylistList />
          </div>
        );
      default:
        return undefined;
    }
  }

  function renderPhone() {
    if (isPage) {
      return (
        <div className={styles.page}>
          <div className={buildClassName(styles.main, 'custom-scroll')} data-music-view={view.kind}>
            {renderView(view)}
          </div>
          <MusicMiniPlayer isDocked />
        </div>
      );
    }
    const tab = getMusicTab(view);
    return (
      <>
        <header className={styles.header}>
          <h1 className={styles.title}>{lang('ParvaneModuleMusic')}</h1>
          {tab === 'home' && Boolean(info!.libraryTracks) && (
            <span className={buildClassName(kit.mono, kit.muted, kit.small)} data-music-total>
              {lang(
                'MusicServerTracks', { count: lang.number(info!.libraryTracks) }, { pluralValue: info!.libraryTracks },
              )}
            </span>
          )}
        </header>
        {/* Пустая библиотека — без вкладок (доска `RpMusicB`) */}
        {(tab !== 'home' || Boolean(info!.libraryTracks)) && (
          <div className={styles.tabsBar}>
            <PvSegment
              className={styles.tabs}
              items={TABS.map((value) => ({ value, label: lang(TAB_KEYS[value]) }))}
              value={tab}
              label={lang('ParvaneModuleMusic')}
              isTabs
              onChange={handleTab}
            />
          </div>
        )}
        <div className={buildClassName(styles.main, 'custom-scroll')} data-music-view={view.kind}>
          {renderView(view)}
        </div>
      </>
    );
  }

  function renderBody() {
    if (!info || info.isFailed) return <PvLoading onRetry={handleRetry} />;
    if (!info.isEnabled) return <PvEmpty text={lang('MusicNotConnected')} data-music-off />;
    if (isPhone) return renderPhone();
    return (
      <div className={styles.layout}>
        <MusicNav view={view} info={info} />
        <div className={buildClassName(styles.main, 'custom-scroll')} data-music-view={view.kind}>
          {renderView(view)}
        </div>
        {view.kind === 'home' && (
          <aside className={styles.side}>
            <MusicQueue />
          </aside>
        )}
      </div>
    );
  }

  return (
    <div
      id="ParvaneMusic"
      className={buildClassName(styles.root, isPage && styles.rootPage)}
      data-music-enabled={info ? String(info.isEnabled) : 'loading'}
      data-music-layout={isPhone ? 'phone' : 'desk'}
    >
      {!isOnline && <PvOfflineBar text={lang('PvOfflineMusic')} onRetry={handleRetry} />}
      {renderBody()}
      <MusicSendDialog track={sentTrack} onClose={handleCloseSend} />
      <MusicNewPlaylist />
    </div>
  );
};

export default memo(Music);
