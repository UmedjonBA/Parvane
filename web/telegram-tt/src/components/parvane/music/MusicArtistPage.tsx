import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicArtistData } from './musicArtistData';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { loadArtist } from './musicArtistData';
import { openMusicFileSheet } from './musicFiles';
import { coverTone } from './musicFormat';
import { getMusicMix, loadMusicMix } from './musicMix';
import {
  callMusic, getCurrentTrack, getMusicInfo, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic, openMusicView } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicArtistAddAll from './MusicArtistAddAll';
import MusicCatalogRow from './MusicCatalogRow';
import MusicCover from './MusicCover';
import MusicMenu from './MusicMenu';
import MusicTrackRow from './MusicTrackRow';

import styles from './MusicPage.module.scss';

type OwnProps = {
  // Исполнитель сервера (`id`) либо каталога (`catalogRef`)
  id?: string;
  catalogRef?: string;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

// Любимых исполнителей «Микса дня» — не больше
const MIX_ARTISTS_MAX = 20;

// Parvane (макет «Музыки» 23 ноя, доска `XpMusic`): исполнитель — большое имя на цветном фоне, «каталог · на сервере
// 9 из 75 треков», ▶; «Популярное» — треки сервера по прослушиваниям, дальше самые слушаемые в каталоге, которых на
// сервере нет; релизы — сервера и каталога одной лентой. Исполнитель сервера ищется и в каталоге по имени
const MusicArtistPage = ({
  id, catalogRef, isPhone, onSendToChat,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const { data, isFailed, reload, patch } = useMusicData<MusicArtistData>(
    `artist:${id || catalogRef}`,
    () => loadArtist(id, catalogRef),
  );

  const serverTracks = (data?.popular || []).map((row) => row.track).filter(Boolean);

  const handlePlay = useLastCallback((index: number) => {
    if (serverTracks.length) playTracks(serverTracks, index, { source: { kind: 'artist', name: data!.name } });
  });
  const handlePlayAll = useLastCallback(() => handlePlay(0));
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous,
      popular: previous.popular.map((row) => (row.track?.id === track.id ? { track: { ...track, isStarred } } : row)),
    }));
    void setTrackStarred(track, isStarred);
  });
  // «Объединить с другим написанием» (доски `ZpMusicX-04`, `ZdMusicX-03`)
  const info = useDerivedState(getMusicInfo);
  const mix = useDerivedState(getMusicMix);
  // ♡ показывает, в любимых ли исполнитель: настройки микса нужны и без главной
  useEffect(() => {
    if (!getMusicMix()) void loadMusicMix();
  }, []);
  const [isAddAllOpen, openAddAll, closeAddAll] = useFlag();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | true>();
  const favoriteRef = data?.catalogArtist?.ref;
  const isFavorite = Boolean(favoriteRef && mix?.settings.artists.some((artist) => artist.ref === favoriteRef));
  // ♡: исполнитель — в любимых «Микса дня» (до 20)
  const handleFavorite = useLastCallback(async () => {
    const artist = data?.catalogArtist;
    if (!artist) return;
    const chosen = getMusicMix()?.settings.artists || [];
    const artists = isFavorite ? chosen.filter((item) => item.ref !== artist.ref)
      : [...chosen, artist].slice(-MIX_ARTISTS_MAX);
    await callMusic('parvaneMusicMixSettings', { artists }).catch(() => undefined);
    void loadMusicMix();
  });
  const handleMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setMenuAnchor(isPhone ? true : { x: box.left, y: box.bottom });
  });
  const closeMenu = useLastCallback(() => setMenuAnchor(undefined));
  const handleMenuPick = useLastCallback((key: string) => {
    setMenuAnchor(undefined);
    if (key === 'merge' && id && data) openMusicFileSheet({ kind: 'merge', artistId: id, name: data.name });
    else if (key === 'share' && data) {
      copyTextToClipboard(data.name);
      showNotification({ message: lang('MusicShareCopied') });
    }
  });
  const handleOpenRelease = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id: releaseId } = e.currentTarget.dataset;
    openMusicView({ kind: kind as 'album', id: releaseId! });
  });

  function renderBack() {
    return (
      <button type="button" className={styles.back} aria-label={lang('Back')} data-music-back onClick={goBackMusic}>
        <ParvaneIcon name="left" />
      </button>
    );
  }

  if (!data) {
    return (
      <div className={styles.root}>
        {renderBack()}
        {isFailed ? <div role="alert">{lang('MusicLoadFailed')}</div> : <PvSkeleton onRetry={reload} />}
      </div>
    );
  }

  const tone = coverTone(id || catalogRef || data.name);
  const sub = [
    data.isInCatalog ? lang('MusicArtistCatalog') : undefined,
    data.catalogTracks > data.serverTracks
      ? lang('MusicArtistOwnedOf', { owned: data.serverTracks, total: data.catalogTracks })
      // Исполнитель только из каталога: на сервере ничего — число выпусков, а не «0 треков»
      : !data.serverTracks && data.releases.length
        ? lang('MusicReleasesCount', { count: data.releases.length }, { pluralValue: data.releases.length })
        : lang('MusicTracksCount', { count: data.serverTracks }, { pluralValue: data.serverTracks }),
  ].filter(Boolean).join(' · ');
  let trackIndex = -1;

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-artist-page>
      <div className={buildClassName(styles.hero, styles.heroArtist)} style={`--hero-tone: ${tone}`}>
        {renderBack()}
        <ParvaneIcon name="mic" className={styles.heroGlyph} />
        <div className={styles.heroText}>
          <h1 className={buildClassName(styles.title, styles.titleArtist)}>{data.name}</h1>
          <div className={styles.meta}>{sub}</div>
        </div>
      </div>
      {/* Доска `XpMusic-01`: ♡ — в любимые исполнители микса, ⊕ — «Добавить на сервер всё», ⋯, большой ▶ */}
      <div className={styles.actions}>
        {data.catalogArtist && (
          <button
            type="button"
            className={buildClassName(styles.action, isFavorite && styles.actionOn)}
            aria-label={lang(isFavorite ? 'MusicArtistUnfavorite' : 'MusicArtistFavorite')}
            aria-pressed={isFavorite}
            data-music-artist-favorite
            onClick={handleFavorite}
          >
            <ParvaneIcon name={isFavorite ? 'heart' : 'heartPlus'} />
          </button>
        )}
        {data.catalogArtist && info?.isFetchEnabled && (
          <button
            type="button"
            className={styles.action}
            aria-label={lang('MusicAddAllToServer')}
            data-music-artist-add-all
            onClick={openAddAll}
          >
            <ParvaneIcon name="cloudAdd" />
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          aria-label={lang('MusicMoreActions')}
          data-music-artist-menu
          onClick={handleMenu}
        >
          <ParvaneIcon name="dotsH" />
        </button>
        <span className={styles.actionsGap} />
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
      </div>
      {menuAnchor && (
        <MusicMenu
          title={data.name}
          actions={[
            ...(id ? [{ key: 'merge', title: lang('MusicMergeArtistsAction') }] : []),
            { key: 'share', title: lang('MusicShare') },
          ]}
          anchor={menuAnchor === true ? undefined : menuAnchor}
          onPick={handleMenuPick}
          onClose={closeMenu}
        />
      )}
      {isAddAllOpen && data.catalogArtist && (
        <MusicArtistAddAll artist={data.catalogArtist} onClose={closeAddAll} />
      )}
      {Boolean(data.popular.length) && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{lang('MusicPopular')}</h2>
          <ul className={styles.rows} data-music-tracks>
            {data.popular.map((row, position) => {
              if (row.catalog) {
                return (
                  <MusicCatalogRow
                    key={`c:${row.catalog.ref || position}`}
                    track={row.catalog}
                    rank={position + 1}
                    sub={row.catalog.album || lang('MusicInCatalogShort')}
                  />
                );
              }
              trackIndex += 1;
              const track = row.track!;
              return (
                <MusicTrackRow
                  key={`t:${track.id}`}
                  track={track}
                  index={trackIndex}
                  rank={position + 1}
                  isAlbumLine
                  isCurrent={track.id === current?.id}
                  isPlaying={player.isPlaying}
                  canQueue
                  canSaveOffline
                  onPlay={handlePlay}
                  onStar={handleStar}
                  onSendToChat={onSendToChat}
                />
              );
            })}
          </ul>
        </section>
      )}
      {Boolean(data.releases.length) && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{lang('MusicReleases')}</h2>
          <div className={styles.strip} data-music-albums>
            {data.releases.map((release) => (
              <button
                key={release.key}
                type="button"
                className={styles.tile}
                data-kind={release.kind}
                data-id={release.id}
                onClick={handleOpenRelease}
              >
                <MusicCover
                  coverId={release.coverId}
                  coverUrl={release.coverUrl}
                  toneId={release.id}
                  size={120}
                  glyph="disc"
                  className={styles.tileCover}
                />
                <span className={styles.tileTitle}>{release.title}</span>
                <span className={styles.tileSub}>{release.sub}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

export default memo(MusicArtistPage);
