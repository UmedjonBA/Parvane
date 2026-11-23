import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicCatalogTrack, MusicTrack } from '../../../api/parvane/musicApi';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';

import buildClassName from '../../../util/buildClassName';
import { startFetchAlbum } from './fetch/musicFetch';
import { openMusicFileSheet } from './musicFiles';
import { coverTone } from './musicFormat';
import { saveTracksOffline } from './musicOffline';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic, openMusicView } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCatalogRow from './MusicCatalogRow';
import MusicCover from './MusicCover';
import MusicMenu from './MusicMenu';
import MusicTrackRow from './MusicTrackRow';

import styles from './MusicPage.module.scss';

type OwnProps = {
  // Альбом сервера (`id`) либо каталога (`catalogRef`, `dz:<id>`)
  id?: string;
  catalogRef?: string;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

// Строка альбома: трек сервера либо трек каталога, которого на сервере нет
type Row = { track?: MusicTrack; catalog?: MusicCatalogTrack };

type Album = {
  title: string;
  artist: string;
  artistId?: string;
  artistRef?: string;
  year: number;
  coverId?: string;
  coverUrl?: string;
  kind: string;
  rows: Row[];
  albumRef?: string;
};

const PHONE_MAX_WIDTH = 925;

// Parvane (макет «Музыки» 23 ноя, доски `XpMusic`, `DeskMusicMore`): альбом — обложка на цветном фоне, название,
// исполнитель, «Альбом · 2023 · 5 из 9 на сервере», «Добавить на сервер» всё недостающее, ▶. Треки сервера и
// каталога вперемешку по порядку альбома: чего нет на сервере — серым с облачком
const MusicAlbumPage = ({
  id, catalogRef, isPhone, onSendToChat,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const [menuAnchor, setMenuAnchor] = useState<CloudMenuAnchor | true>();
  const { data, isFailed, reload, patch } = useMusicData<Album>(`album:${id || catalogRef}`, async () => {
    if (catalogRef) return loadCatalogAlbum(catalogRef);
    return loadServerAlbum(id!);
  });

  const serverTracks = (data?.rows || []).map((row) => row.track).filter(Boolean);
  const missing = (data?.rows || []).filter((row) => row.catalog).length;
  const total = data?.rows.length || 0;

  const handlePlay = useLastCallback((index: number) => {
    if (serverTracks.length) playTracks(serverTracks, index, { source: { kind: 'album', name: data!.title } });
  });
  const handlePlayAll = useLastCallback(() => handlePlay(0));
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous,
      rows: previous.rows.map((row) => (row.track?.id === track.id ? { track: { ...track, isStarred } } : row)),
    }));
    void setTrackStarred(track, isStarred);
  });
  // «В Любимое» альбомом: все его треки на сервере; все уже там — убрать
  const isAllStarred = serverTracks.length > 0 && serverTracks.every((track) => track.isStarred);
  const handleStarAll = useLastCallback(() => {
    const isStarred = !isAllStarred;
    serverTracks.filter((track) => track.isStarred !== isStarred).forEach((track) => {
      void setTrackStarred(track, isStarred);
    });
    patch((previous) => ({
      ...previous,
      rows: previous.rows.map((row) => (row.track ? { track: { ...row.track, isStarred } } : row)),
    }));
  });
  const handleAddAll = useLastCallback(async () => {
    if (!data?.albumRef) return;
    const result = await startFetchAlbum(data.albumRef);
    showNotification({
      message: result === 'ok' ? lang('MusicAddingToServer', { count: missing }, { pluralValue: missing })
        : result === 'limit' ? lang('MusicFetchLimit') : lang('MusicFetchFailedShort'),
    });
  });
  const handleOpenArtist = useLastCallback(() => {
    if (data?.artistId) openMusicView({ kind: 'artist', id: data.artistId });
    else if (data?.artistRef) openMusicView({ kind: 'catalogArtist', id: data.artistRef });
  });
  const handleMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setMenuAnchor(window.innerWidth <= PHONE_MAX_WIDTH ? true : { x: box.left, y: box.bottom });
  });
  const handleCloseMenu = useLastCallback(() => setMenuAnchor(undefined));
  const handlePick = useLastCallback((key: string) => {
    setMenuAnchor(undefined);
    if (key === 'offline') saveTracksOffline(serverTracks, id ? { kind: 'album', id } : undefined);
    else if (key === 'shuffle') {
      playTracks(serverTracks, 0, { isShuffled: true, source: { kind: 'album', name: data!.title } });
    } else if (key === 'chat' && serverTracks[0]) onSendToChat(serverTracks[0]);
    else if (key === 'add') void handleAddAll();
    else if (key === 'edit' && id) openMusicFileSheet({ kind: 'album', albumId: id, tracks: serverTracks });
  });

  if (!data) {
    return (
      <div className={styles.root}>
        {renderBack()}
        {isFailed ? <div role="alert">{lang('MusicLoadFailed')}</div> : <PvSkeleton onRetry={reload} />}
      </div>
    );
  }

  const tone = coverTone(id || catalogRef || data.title);
  const owned = total - missing;
  const meta = [
    lang(KIND_KEYS[data.kind] || 'MusicKindAlbum'),
    data.year || undefined,
    missing
      ? lang('MusicOwnedOf', { owned, total })
      : lang('MusicTracksCount', { count: total }, { pluralValue: total }),
  ].filter(Boolean).join(' · ');
  let trackIndex = -1;

  function renderBack() {
    return (
      <button type="button" className={styles.back} aria-label={lang('Back')} data-music-back onClick={goBackMusic}>
        <ParvaneIcon name="left" />
      </button>
    );
  }

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-album-page>
      <div className={styles.hero} style={`--hero-tone: ${tone}`}>
        {renderBack()}
        <MusicCover
          coverId={data.coverId}
          coverUrl={data.coverUrl}
          toneId={id || catalogRef || data.title}
          size={isPhone ? 220 : 150}
          glyph="disc"
          isLarge
          className={styles.heroCover}
        />
        <div className={styles.heroText}>
          {!isPhone && (
            <div className={styles.kicker}>{lang(catalogRef ? 'MusicAlbumCatalog' : 'MusicKindAlbum')}</div>
          )}
          <h1 className={styles.title}>{data.title}</h1>
          <button type="button" className={styles.artistLink} onClick={handleOpenArtist}>
            <span className={styles.artistBadge} style={`--hero-tone: ${tone}`}>{data.artist.slice(0, 1)}</span>
            {data.artist}
          </button>
          <div className={styles.meta}>{meta}</div>
        </div>
      </div>
      <div className={styles.actions}>
        {!isPhone && renderPlay()}
        {Boolean(serverTracks.length) && (
          <button
            type="button"
            className={buildClassName(styles.action, isAllStarred && styles.actionOn)}
            aria-label={lang(isAllStarred ? 'MusicUnstar' : 'MusicStar')}
            aria-pressed={isAllStarred}
            data-music-star-album
            onClick={handleStarAll}
          >
            <ParvaneIcon name={isAllStarred ? 'heart' : 'heartPlus'} />
          </button>
        )}
        {missing > 0 && Boolean(data.albumRef) && (
          <button
            type="button"
            className={styles.action}
            aria-label={lang('MusicAddAllToServer')}
            data-music-add-album
            onClick={handleAddAll}
          >
            <ParvaneIcon name="cloudAdd" />
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          aria-label={lang('MusicMoreActions')}
          onClick={handleMenu}
        >
          <ParvaneIcon name="dotsH" />
        </button>
        {isPhone && renderPlay()}
      </div>
      <ul className={styles.rows} data-music-tracks>
        {data.rows.map((row, position) => {
          if (row.catalog) {
            return <MusicCatalogRow key={`c:${row.catalog.ref || position}`} track={row.catalog} />;
          }
          trackIndex += 1;
          const track = row.track!;
          return (
            <MusicTrackRow
              key={`t:${track.id}`}
              track={track}
              index={trackIndex}
              isCurrent={track.id === current?.id}
              isPlaying={player.isPlaying}
              rank={isPhone ? undefined : position + 1}
              canQueue
              canSaveOffline
              onPlay={handlePlay}
              onStar={handleStar}
              onSendToChat={onSendToChat}
            />
          );
        })}
      </ul>
      {menuAnchor && (
        <MusicMenu
          title={data.title}
          facts={data.artist}
          actions={[
            ...(missing && data.albumRef ? [{ key: 'add', title: lang('MusicAddAllToServer') }] : []),
            ...(id && serverTracks.length ? [{ key: 'edit', title: lang('MusicEditAlbum') }] : []),
            ...(serverTracks.length ? [
              { key: 'shuffle', title: lang('MusicShuffleOn') },
              { key: 'offline', title: lang(isPhone ? 'MusicOfflineSaveTrack' : 'MusicOfflineSaveDesk') },
              { key: 'chat', title: lang('MusicSendToChat') },
            ] : []),
          ]}
          anchor={menuAnchor === true ? undefined : menuAnchor}
          onPick={handlePick}
          onClose={handleCloseMenu}
        />
      )}
    </div>
  );

  function renderPlay() {
    return (
      <button
        type="button"
        className={styles.play}
        aria-label={lang('MusicPlay')}
        disabled={!serverTracks.length}
        data-music-play-all
        onClick={handlePlayAll}
      >
        <ParvaneIcon name="play" />
      </button>
    );
  }
};

const KIND_KEYS: Record<string, 'MusicKindAlbum' | 'MusicKindSingleTitle' | 'MusicKindEp' | 'MusicKindCompile'> = {
  album: 'MusicKindAlbum',
  single: 'MusicKindSingleTitle',
  ep: 'MusicKindEp',
  compile: 'MusicKindCompile',
};

/** Альбом сервера; его же в каталоге (по исполнителю и названию) — чтобы показать, чего на сервере нет. */
async function loadServerAlbum(albumId: string): Promise<Album> {
  const { album, tracks } = await callMusic('parvaneMusicAlbum', { albumId });
  return {
    title: album?.title || '',
    artist: album?.artist || '',
    artistId: album?.artistId,
    year: album?.year || 0,
    coverId: album?.coverId,
    kind: album?.isSingle ? 'single' : 'album',
    rows: tracks.map((track) => ({ track })),
  };
}

/** Альбом каталога: треки, уже лежащие на сервере, — его строками (их можно играть), прочие — строками каталога. */
async function loadCatalogAlbum(ref: string): Promise<Album> {
  const { album, tracks } = await callMusic('parvaneMusicCatalogAlbum', { ref });
  const ownedIds = tracks.map((track) => track.libraryTrackId).filter(Boolean);
  const owned = ownedIds.length ? await callMusic('parvaneMusicTracks', { trackIds: ownedIds }).catch(() => []) : [];
  const byId = new Map(owned.map((track) => [track.id, track]));
  return {
    title: album?.title || '',
    artist: album?.artist || '',
    artistRef: album?.artistRef,
    year: album?.year || 0,
    coverUrl: album?.coverUrl || undefined,
    kind: album?.recordType || 'album',
    albumRef: ref,
    rows: tracks.map((track) => {
      const server = track.libraryTrackId ? byId.get(track.libraryTrackId) : undefined;
      return server ? { track: server } : { catalog: track };
    }),
  };
}

export default memo(MusicAlbumPage);
