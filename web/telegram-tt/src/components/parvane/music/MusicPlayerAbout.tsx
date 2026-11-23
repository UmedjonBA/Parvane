import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import { loadArtist } from './musicArtistData';
import { formatFileQuality, formatFileSource, openMusicFileSheet } from './musicFiles';
import { coverTone, formatMusicDate } from './musicFormat';
import { callMusic } from './musicPlayer';
import { closeMusicPlayer } from './musicPlayerView';
import { openMusicView } from './musicView';
import useMusicData from './useMusicData';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './MusicPlayerScreen.module.scss';

type OwnProps = {
  track: MusicTrack;
};

// Parvane (макет «Музыки» 23 ноя, доска `MusicPlayer-03`): под плеером при прокрутке — «Об исполнителе» (полоса тоном
// исполнителя, «На сервере N треков и M альбомов. Чаще всех слушает … В каталоге ещё K альбомов», «К исполнителю») и
// «Об этом файле» (источник, качество, кто и когда добавил, другие версии, «Подробнее — откуда файл»)
const MusicPlayerAbout = ({ track }: OwnProps) => {
  const lang = useLang();
  const { data: artist } = useMusicData(
    track.artistId ? `artist:${track.artistId}` : undefined,
    () => loadArtist(track.artistId, undefined),
  );
  const { data: file } = useMusicData(
    track.id && !track.previewUrl ? `file:${track.id}` : undefined,
    () => callMusic('parvaneMusicFileInfo', { trackId: track.id }),
  );

  const handleOpenArtist = useLastCallback(() => {
    closeMusicPlayer();
    openMusicView({ kind: 'artist', id: track.artistId });
  });
  const handleOpenFile = useLastCallback(() => openMusicFileSheet({ kind: 'info', track }));

  function renderArtist() {
    if (!track.artistId) return undefined;
    const facts = artist ? [
      lang('MusicAboutOnServer', {
        tracks: lang('MusicTracksCount', { count: artist.serverTracks }, { pluralValue: artist.serverTracks }),
        albums: lang('MusicAlbumsCount', { count: artist.serverAlbums }, { pluralValue: artist.serverAlbums }),
      }),
      artist.topListener && lang('MusicAboutTopListener', { name: artist.topListener }),
      artist.catalogExtraAlbums > 0 && lang('MusicAboutCatalogMore', {
        albums: lang('MusicAlbumsCount', { count: artist.catalogExtraAlbums }, {
          pluralValue: artist.catalogExtraAlbums,
        }),
      }),
    ].filter(Boolean).join(' ') : '';
    return (
      <section className={styles.aboutCard} data-music-about-artist>
        <div className={styles.aboutBand} style={`--band-tone: ${coverTone(track.artistId)}`}>
          <span className={styles.aboutBandTitle}>{lang('MusicAboutArtist')}</span>
        </div>
        <div className={styles.aboutBody}>
          <div className={styles.aboutName}>{track.artist}</div>
          {facts && <p className={styles.aboutText}>{facts}</p>}
          <div className={styles.aboutButtons}>
            <button type="button" className={styles.aboutButton} onClick={handleOpenArtist}>
              {lang('MusicToArtist')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderFile() {
    if (!file) return undefined;
    const others = file.versions.filter((version) => version.id !== track.id);
    return (
      <section className={styles.fileCard} data-music-about-file>
        <h3 className={styles.fileTitle}>{lang('MusicAboutFile')}</h3>
        <dl className={styles.fileRows}>
          <dt className={styles.fileLabel}>{lang('MusicFileSource')}</dt>
          <dd className={styles.fileValue}>{formatFileSource(lang, file)}</dd>
          <dt className={styles.fileLabel}>{lang('MusicFileQualityLabel')}</dt>
          <dd className={styles.fileValue}>{formatFileQuality(lang, file) || '—'}</dd>
          {file.adder && (
            <>
              <dt className={styles.fileLabel}>{lang('MusicFileAdded')}</dt>
              <dd className={styles.fileValue}>{`${file.adder} · ${formatMusicDate(lang, file.addedMs)}`}</dd>
            </>
          )}
          {Boolean(others.length) && (
            <>
              <dt className={styles.fileLabel}>{lang('MusicFileVersions')}</dt>
              <dd className={styles.fileValue}>
                {lang('MusicFileVersionsMore', { count: others.length }, { pluralValue: others.length })}
                {others.map((version) => (
                  <span key={version.id} className={styles.fileTag}>{`v${version.version || 1}`}</span>
                ))}
              </dd>
            </>
          )}
        </dl>
        <button type="button" className={styles.fileMore} onClick={handleOpenFile}>
          {lang('MusicFileMoreOrigin')}
        </button>
      </section>
    );
  }

  return (
    <>
      {renderArtist()}
      {renderFile()}
    </>
  );
};

export default memo(MusicPlayerAbout);
