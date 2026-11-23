import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';
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
import { getIsMusicPlayerOpen } from './musicPlayerView';
import { refreshPlaylists } from './musicPlaylists';
import {
  consumeMusicAddRequest, getIsMusicPage, getMusicAddRequest, getMusicQuery, getMusicTab, getMusicView, goBackMusic,
  openMusicView, openNewPlaylist, openUploadsWith, setMusicQuery,
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
import MusicUploadsView from './fetch/MusicUploadsView';
import MusicAddedView from './MusicAddedView';
import MusicAlbumPage from './MusicAlbumPage';
import MusicAlbumView from './MusicAlbumView';
import MusicArtistPage from './MusicArtistPage';
import MusicBrowseView from './MusicBrowseView';
import MusicDeskPlayer from './MusicDeskPlayer';
import MusicDislikesView from './MusicDislikesView';
import MusicFileSheets from './MusicFileSheets';
import MusicHomeView from './MusicHomeView';
import MusicLibraryItems from './MusicLibraryItems';
import MusicLibraryView from './MusicLibraryView';
import MusicMenu from './MusicMenu';
import MusicMiniPlayer from './MusicMiniPlayer';
import MusicMixArtistsView from './MusicMixArtistsView';
import MusicMixView from './MusicMixView';
import MusicNewPlaylist from './MusicNewPlaylist';
import MusicOffline from './MusicOffline';
import MusicPlayerScreen from './MusicPlayerScreen';
import MusicPlaylistList from './MusicPlaylistList';
import MusicPlaylists from './MusicPlaylists';
import MusicQueue from './MusicQueue';
import MusicSearchView from './MusicSearchView';
import MusicSectionHead from './MusicSectionHead';
import MusicSendDialog from './MusicSendDialog';
import MusicStarredView from './MusicStarredView';
import MusicTrashView from './MusicTrashView';
import MusicUploadStatus from './MusicUploadStatus';
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
  // Компьютер: меню «…» медиатеки у кнопки
  const [libraryMenu, setLibraryMenu] = useState<CloudMenuAnchor>();
  const isShown = section === 'music';
  const isEnabled = info?.isEnabled;
  const isOnline = useBrowserOnline();
  const isPage = isPhone && view.kind !== 'home' && view.kind !== 'search' && view.kind !== 'library';
  const query = useDerivedState(getMusicQuery);
  const isPlayerOpen = useDerivedState(getIsMusicPlayerOpen);
  const isSearchBar = view.kind === 'home' || view.kind === 'search';
  const deskSearchRef = useRef<HTMLInputElement>();

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
    // «Вставить ссылку» и «Загрузить файл» — на странице «Загрузки на сервер» (доски `RpMusicB`, `RdMusic`)
    if (addRequest === 'link' || addRequest === 'file') {
      openUploadsWith(addRequest);
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
  const handleTab = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: e.currentTarget.dataset.value as MusicTab }, true);
  });
  const handleCloseSend = useLastCallback(() => setSentTrack(undefined));
  const handleNewPlaylist = useLastCallback(() => openNewPlaylist());
  const handleOpenSearch = useLastCallback(() => {
    openMusicView({ kind: 'search' }, true);
    deskSearchRef.current?.focus();
  });
  const handleDeskQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setMusicQuery(e.currentTarget.value);
    if (view.kind !== 'search') openMusicView({ kind: 'search' }, true);
  });
  const handleLibraryMore = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setLibraryMenu({ x: rect.left, y: rect.bottom });
  });
  const closeLibraryMenu = useLastCallback(() => setLibraryMenu(undefined));
  const handleLibraryPick = useLastCallback((key: string) => {
    setLibraryMenu(undefined);
    if (key === 'newPlaylist') openNewPlaylist();
    else if (key === 'dislikes') openMusicView({ kind: 'dislikes' }, true);
    else if (key === 'trash') openMusicView({ kind: 'trash' }, true);
  });

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
        return <MusicAlbumPage id={current.id} {...common} />;
      case 'catalogAlbum':
        return <MusicAlbumPage catalogRef={current.id} {...common} />;
      case 'catalogArtist':
        return <MusicArtistPage catalogRef={current.id} {...common} />;
      case 'singles':
        return <MusicAlbumView singlesOf={current.id} info={info!} {...common} />;
      case 'artist':
        return <MusicArtistPage id={current.id} {...common} />;
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
      case 'queue':
        return <MusicQueue />;
      case 'dislikes':
        return <MusicDislikesView isPhone={isPhone} />;
      case 'trash':
        return <MusicTrashView isPhone={isPhone} />;
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
        {/* Доски `MusicHome`, `MusicSearch`, `MusicLibrary`: вкладки в полосе шапки, без заголовка модуля */}
        <nav className={styles.tabsBar} aria-label={lang('ParvaneModuleMusic')}>
          <div className={styles.tabs} role="tablist">
            {TABS.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={value === tab}
                className={buildClassName(styles.tab, value === tab && styles.tabOn)}
                data-view={value}
                data-value={value}
                onClick={handleTab}
              >
                {lang(TAB_KEYS[value])}
              </button>
            ))}
          </div>
        </nav>
        <div className={buildClassName(styles.main, 'custom-scroll')} data-music-view={view.kind}>
          {renderView(view)}
        </div>
        <div className={styles.phoneUploads}><MusicUploadStatus isPhone /></div>
      </>
    );
  }

  function renderBody() {
    if (!info || info.isFailed) return <PvLoading onRetry={handleRetry} />;
    if (!info.isEnabled) return <PvEmpty text={lang('MusicNotConnected')} data-music-off />;
    if (isPhone) return renderPhone();
    // Доска `DeskMusic`: медиатека слева, вид в середине на своей панели, плеер внизу во всю ширину
    return (
      <div className={styles.desk}>
        {isPlayerOpen ? <MusicPlayerScreen isInline /> : (
          <div className={styles.deskRow}>
            <aside className={styles.deskLibrary} aria-label={lang('MusicLibrary')} data-music-nav>
              <div className={styles.deskLibraryHead}>
                <span className={styles.deskLibraryTitle}>{lang('MusicLibrary')}</span>
                <button
                  type="button"
                  className={styles.deskLibraryButton}
                  aria-label={lang('MusicSearch')}
                  data-view="search"
                  onClick={handleOpenSearch}
                >
                  <ParvaneIcon name="search" isSmall />
                </button>
                <button
                  type="button"
                  className={styles.deskLibraryButton}
                  aria-label={lang('MusicLibraryMore')}
                  data-music-library-more
                  onClick={handleLibraryMore}
                >
                  <ParvaneIcon name="dotsH" isSmall />
                </button>
              </div>
              <div className={buildClassName(styles.deskLibraryList, 'custom-scroll')}>
                <MusicLibraryItems info={info} view={view} />
              </div>
            </aside>
            <div className={styles.deskCenter}>
              <div
                className={buildClassName(styles.deskPanel, styles.main, 'custom-scroll')}
                data-music-view={view.kind}
              >
                {/* Доска `DeskMusic`: на главной и в поиске сверху — поле поиска и «Добавляем N», на остальных — только
                  чип в углу */}
                {isSearchBar ? (
                  <div className={styles.deskTop}>
                    <div className={styles.deskSearch}>
                      <ParvaneIcon name="search" isSmall className={styles.deskSearchIcon} />
                      <input
                        ref={deskSearchRef}
                        className={styles.deskSearchInput}
                        type="search"
                        value={query}
                        placeholder={lang('MusicSearchWhat')}
                        aria-label={lang('MusicSearchWhat')}
                        data-music-desk-search
                        onChange={handleDeskQuery}
                      />
                    </div>
                    <span className={styles.deskTopGap} />
                    <MusicUploadStatus />
                  </div>
                ) : (
                  <div className={styles.deskCorner}><MusicUploadStatus /></div>
                )}
                {renderView(view)}
              </div>
            </div>
          </div>
        )}
        <MusicDeskPlayer />
        {libraryMenu && (
          <MusicMenu
            title={lang('MusicLibrary')}
            actions={[
              { key: 'newPlaylist', title: lang('MusicPlaylistNew') },
              { key: 'dislikes', title: lang('MusicDislikes') },
              { key: 'trash', title: lang('MusicTrash') },
            ]}
            anchor={libraryMenu}
            onPick={handleLibraryPick}
            onClose={closeLibraryMenu}
          />
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
      <MusicFileSheets />
    </div>
  );
};

export default memo(Music);
