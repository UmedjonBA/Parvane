import { memo } from '../../../lib/teact/teact';

import type { MusicAlbum } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { openMusicView } from './musicView';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import MusicCover from './MusicCover';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  albums: MusicAlbum[];
  // Подпись под названием: «исполнитель · год» (альбомы, доска `RdMusic`) либо «год · N треков» (исполнитель,
  // доски `XpMusic`, `XdMusic`)
  caption?: 'artist' | 'year';
  // Полоса в одну строку (исполнитель); иначе сетка
  isRow?: boolean;
  // Синглы исполнителя — одной плиткой «Синглы · N треков» в конце
  singles?: { artistId: string; trackCount: number };
};

// Parvane (spec 041): плитки альбомов — обложка со значком диска, название и подпись; нажатие открывает альбом
const MusicAlbumTiles = ({
  albums, caption = 'artist', isRow, singles,
}: OwnProps) => {
  const lang = useLang();

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { id, singles: artistId } = e.currentTarget.dataset;
    if (artistId) openMusicView({ kind: 'singles', id: artistId });
    else openMusicView({ kind: 'album', id: id! });
  });

  function renderCaption(album: MusicAlbum) {
    const count = lang('MusicTracksCount', { count: album.trackCount }, { pluralValue: album.trackCount });
    if (caption === 'year') return [album.year || undefined, count].filter(Boolean).join(' · ');
    return [album.artist, album.year || undefined].filter(Boolean).join(' · ');
  }

  return (
    <div className={isRow ? styles.tileRow : styles.tiles} data-music-albums>
      {albums.map((album) => (
        <button key={album.id} type="button" className={styles.tile} data-id={album.id} onClick={handleOpen}>
          <MusicCover coverId={album.coverId} toneId={album.id} size={120} glyph="disc" className={styles.tileCover} />
          <span className={styles.tileTitle}>{album.title}</span>
          <span className={buildClassName(kit.muted, kit.small, styles.tileTitle)}>{renderCaption(album)}</span>
        </button>
      ))}
      {singles && (
        <button
          type="button"
          className={styles.tile}
          data-singles={singles.artistId}
          onClick={handleOpen}
        >
          <MusicCover toneId={`${singles.artistId}-singles`} size={120} glyph="disc" className={styles.tileCover} />
          <span className={styles.tileTitle}>{lang('MusicSingles')}</span>
          <span className={buildClassName(kit.muted, kit.small, styles.tileTitle)}>
            {lang('MusicTracksCount', { count: singles.trackCount }, { pluralValue: singles.trackCount })}
          </span>
        </button>
      )}
    </div>
  );
};

export default memo(MusicAlbumTiles);
