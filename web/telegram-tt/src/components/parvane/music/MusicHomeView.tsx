import { memo } from '../../../lib/teact/teact';

import type { MusicInfo, MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  callMusic, getCurrentTrack, getMusicPlayer, getMusicRecent, loadMusicInfo, playTracks, setTrackStarred,
} from './musicPlayer';
import { getMusicQuery, openMusicView, requestMusicAdd, setMusicQuery } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicUploadFiles from './fetch/MusicUploadFiles';
import MusicAlbumTiles from './MusicAlbumTiles';
import MusicCover from './MusicCover';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

// Плиток «Недавно прослушанное» на главной (доска `DeskMusic`)
const RECENT_TILES = 5;

// Parvane (spec 041, доски `MusicHome`, `DeskMusic`, `RpMusicB`, `ZdMusicX`): главная «Музыки» — поиск и число треков
// сервера (компьютер), «Микс дня» (заглушка — решение пользователя), недавно прослушанное плитками, новое на
// сервере с тем, кто добавил. Пустая библиотека — приглашение найти первый трек
const MusicHomeView = ({ info, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const recent = useDerivedState(getMusicRecent);
  const query = useDerivedState(getMusicQuery);
  const current = getCurrentTrack(player);
  const { data, isFailed, reload, patch } = useMusicData('home', async () => {
    // С подключённым скачиванием «Новое на сервере» — добавленные треки с тем, кто добавил; без него — альбомы
    const [albums, added] = await Promise.all([
      info.isFetchEnabled ? [] : callMusic('parvaneMusicRecent'),
      info.isFetchEnabled ? callMusic('parvaneMusicAdded', { isMine: false }).catch(() => []) : [],
    ]);
    return { albums, added: added.filter((item) => item.track.id) };
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setMusicQuery(e.currentTarget.value);
    openMusicView({ kind: 'search' }, true);
  });

  const handlePlayRecent = useLastCallback((index: number) => playTracks(recent, index, { source: { kind: 'home' } }));
  const handlePlayAdded = useLastCallback((index: number) => {
    playTracks(data!.added.map((item) => item.track), index, { source: { kind: 'home' } });
  });
  const handleRecentTile = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    handlePlayRecent(Number(e.currentTarget.dataset.index));
  });
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous,
      added: previous.added.map((item) => (
        item.track.id === track.id ? { ...item, track: { ...track, isStarred } } : item
      )),
    }));
    void setTrackStarred(track, isStarred);
  });
  const handleFind = useLastCallback(() => requestMusicAdd('fetch'));
  const handleRetry = useLastCallback(() => {
    void loadMusicInfo();
    reload();
  });

  if (isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
  if (!data) return <PvSkeleton onRetry={handleRetry} />;

  // Пустая библиотека: на сервере нет ни трека (недавнее на устройстве — от прежней библиотеки, не в счёт)
  const isEmpty = !info.libraryTracks && !data.albums.length && !data.added.length;
  if (isEmpty) return renderEmpty();

  function renderAdderNote(adder: string) {
    // «добавил я» — для своих треков (доска `DeskMusic`)
    return adder === info.selfName ? lang('MusicAddedByMe') : lang('MusicAddedBy', { name: adder });
  }

  function renderEmpty() {
    if (isPhone) {
      return (
        <PvEmpty
          title={lang('MusicEmptyTitle')}
          text={lang(info.isFetchEnabled ? 'MusicEmptyText' : 'MusicEmptyFetchOff')}
          actionText={info.isFetchEnabled ? lang('MusicEmptyFind') : undefined}
          data-music-empty="library"
          onAction={handleFind}
        >
          <MusicUploadFiles canDropOnWindow />
        </PvEmpty>
      );
    }
    return (
      <section className={styles.emptyLibrary} data-music-empty="library">
        <div>
          <h2 className={styles.listTitle}>{lang('MusicHome')}</h2>
          <div className={buildClassName(kit.muted, kit.small)}>{lang('MusicEmptyCaption')}</div>
        </div>
        <p className={styles.emptyLibraryText}>{lang('MusicEmptyDeskText')}</p>
        <div className={styles.cardList}>
          <div className={styles.cardRow}>
            <ParvaneIcon name="search" className={styles.cardRowIcon} />
            <div className={kit.grow}>
              <div className={styles.trackTitle}>{lang('MusicEmptyFindTitle')}</div>
              <div className={buildClassName(kit.muted, kit.small)}>
                {lang(info.isFetchEnabled ? 'MusicEmptyFindHint' : 'MusicEmptyFetchOff')}
              </div>
            </div>
            {info.isFetchEnabled && (
              <button type="button" className={kit.btn} data-music-empty-find onClick={handleFind}>
                {lang('MusicEmptySearch')}
              </button>
            )}
          </div>
          <MusicUploadFiles canDropOnWindow />
        </div>
        <div className={buildClassName(kit.muted, kit.small)}>{lang('MusicEmptyPlayerHint')}</div>
      </section>
    );
  }

  return (
    <>
      {!isPhone && (
        <div className={styles.homeSearch}>
          <input
            className={buildClassName(kit.input, styles.search)}
            type="search"
            value={query}
            placeholder={lang('MusicSearchPlaceholder')}
            aria-label={lang('MusicSearchPlaceholder')}
            onChange={handleQuery}
          />
          {Boolean(info.libraryTracks) && (
            <span className={buildClassName(kit.mono, kit.muted, kit.small)} data-music-total>
              {lang(
                'MusicTracksCount', { count: lang.number(info.libraryTracks) }, { pluralValue: info.libraryTracks },
              )}
            </span>
          )}
        </div>
      )}
      <section className={styles.mix} data-music-mix>
        <div className={kit.grow}>
          <div className={buildClassName(kit.caps, styles.mixCaps)}>{lang('MusicMixTitle')}</div>
          <div className={styles.mixText}>{lang('MusicMixSoon')}</div>
        </div>
      </section>
      {Boolean(recent.length) && (
        <>
          <div className={kit.caps}>{lang('MusicRecentlyPlayed')}</div>
          <div className={styles.tileRow} data-music-recent>
            {recent.slice(0, RECENT_TILES).map((track, index) => (
              <button
                key={track.id}
                type="button"
                className={styles.tile}
                data-index={index}
                data-track={track.id}
                onClick={handleRecentTile}
              >
                <MusicCover
                  coverId={track.coverId}
                  toneId={track.albumId || track.id}
                  size={96}
                  className={styles.tileCover}
                />
                <span className={styles.tileTitle}>{track.title}</span>
                <span className={buildClassName(kit.muted, kit.small, styles.tileTitle)}>{track.artist}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {(Boolean(data.added.length) || Boolean(data.albums.length)) && (
        <div className={kit.caps}>{lang('MusicNewOnServer')}</div>
      )}
      {Boolean(data.albums.length) && <MusicAlbumTiles albums={data.albums} />}
      {Boolean(data.added.length) && (
        <ul className={styles.tracks} data-music-added="all">
          {data.added.map((item, index) => (
            <MusicTrackRow
              key={item.track.id}
              track={item.track}
              index={index}
              isCurrent={item.track.id === current?.id}
              isPlaying={player.isPlaying}
              note={renderAdderNote(item.adder)}
              columns={isPhone ? undefined : ['artist', 'note']}
              trailing="offline"
              canQueue
              canSaveOffline
              onPlay={handlePlayAdded}
              onStar={handleStar}
              onSendToChat={onSendToChat}
            />
          ))}
        </ul>
      )}
    </>
  );
};

export default memo(MusicHomeView);
