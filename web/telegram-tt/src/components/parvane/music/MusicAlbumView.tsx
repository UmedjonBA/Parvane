import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type {
  MusicAlbum, MusicInfo, MusicPlaylist, MusicTrack,
} from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { splitListTime } from './musicFormat';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic, openMusicView, requestMusicAdd, setMusicQuery } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicOfflineCircle from './MusicOfflineCircle';
import MusicPlayButtons from './MusicPlayButtons';
import MusicSectionHead from './MusicSectionHead';
import MusicSendDialog from './MusicSendDialog';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  // Альбом либо синглы исполнителя (`singlesOf` — id исполнителя)
  albumId?: string;
  singlesOf?: string;
  info: MusicInfo;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

type AlbumPage = {
  album?: MusicAlbum;
  // Синглы: исполнитель
  artistName?: string;
  tracks: MusicTrack[];
  // «На сервере 7 из 9 треков альбома»: сколько треков у альбома в каталоге
  catalogCount?: number;
};

const COVER_PHONE = 96;
const COVER_DESK = 72;

/** Сколько треков альбома знает каталог «Найти и скачать»: строки каталога с тем же альбомом и исполнителем. */
async function countCatalogTracks(album: MusicAlbum) {
  const found = await callMusic('parvaneMusicFetchCatalog', { query: `${album.artist} ${album.title}` })
    .catch(() => []);
  const fold = (text: string) => text.trim().toLowerCase();
  return found.filter((track) => fold(track.album) === fold(album.title) && fold(track.artist) === fold(album.artist))
    .length;
}

// Parvane (spec 041, доски `RpMusicA`, `MusicPlaylist`, `XpMusic`): страница альбома — обложка, исполнитель ссылкой,
// «год · N треков · время», «Играть / Вперемешку», загрузка на устройство, номера строк; «На сервере N из M
// треков альбома. Найти и скачать остальные». Та же страница показывает синглы исполнителя
const MusicAlbumView = ({
  albumId, singlesOf, info, isPhone, onSendToChat,
}: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const [isSendOpen, setIsSendOpen] = useState(false);
  const { data, isFailed, patch } = useMusicData<AlbumPage>(albumId || `singles:${singlesOf}`, async () => {
    if (singlesOf) {
      const { artist, albums } = await callMusic('parvaneMusicArtist', { artistId: singlesOf });
      const parts = await Promise.all(albums.filter((album) => album.isSingle)
        .map((album) => callMusic('parvaneMusicAlbum', { albumId: album.id }).then((reply) => reply.tracks)));
      return { artistName: artist?.name, tracks: parts.flat() };
    }
    const { album, tracks } = await callMusic('parvaneMusicAlbum', { albumId: albumId! });
    const catalogCount = album && info.isFetchEnabled ? await countCatalogTracks(album) : undefined;
    return { album, tracks, catalogCount };
  });
  const tracks = useMemo(() => data?.tracks || [], [data]);
  const title = data?.album?.title || lang('MusicSingles');
  const source = { kind: 'album' as const, name: title };

  // Отправка альбома в чат — карточкой плейлиста (снимок, PLAYLIST-1)
  const asPlaylist = useMemo((): MusicPlaylist | undefined => (isSendOpen ? {
    id: albumId || '',
    name: title,
    count: tracks.length,
    durationSecs: tracks.reduce((sum, track) => sum + track.durationSecs, 0),
    items: tracks.map((track) => ({
      id: track.id, trackId: track.id, title: track.title, artist: track.artist, durationSecs: track.durationSecs,
    })),
  } : undefined), [isSendOpen, albumId, title, tracks]);

  const handlePlay = useLastCallback((index: number) => playTracks(tracks, index, { source }));
  const handlePlayAll = useLastCallback(() => handlePlay(0));
  const handleShuffle = useLastCallback(() => playTracks(tracks, 0, { isShuffled: true, source }));
  const handleArtist = useLastCallback(() => {
    const artistId = data?.album?.artistId || singlesOf;
    if (artistId) openMusicView({ kind: 'artist', id: artistId });
  });
  const handleFindRest = useLastCallback(() => {
    setMusicQuery(`${data!.album!.artist} ${data!.album!.title}`);
    requestMusicAdd('fetch');
  });
  const handleSend = useLastCallback(() => setIsSendOpen(true));
  const handleCloseSend = useLastCallback(() => setIsSendOpen(false));
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous, tracks: previous.tracks.map((item) => (item.id === track.id ? { ...item, isStarred } : item)),
    }));
    void setTrackStarred(track, isStarred);
  });

  if (isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
  if (!data) return <PvSkeleton />;

  const time = splitListTime(tracks.reduce((sum, track) => sum + track.durationSecs, 0));
  const facts = [
    data.album?.year || undefined,
    lang('MusicTracksCount', { count: tracks.length }, { pluralValue: tracks.length }),
    lang('MusicListTime', { hours: time.hours, minutes: time.minutes }),
  ].filter(Boolean).join(' · ');
  const artistName = data.album?.artist || data.artistName;
  const missing = data.catalogCount && data.catalogCount > tracks.length ? data.catalogCount : undefined;
  const sendButton = (
    <button type="button" className={kit.ib} aria-label={lang('MusicSendToChat')} onClick={handleSend}>
      <ParvaneIcon name="send" />
    </button>
  );

  return (
    <div className={styles.view} data-music-album={albumId || singlesOf}>
      <MusicSectionHead
        title={title}
        barTitle={lang(singlesOf ? 'MusicSingles' : 'MusicKindAlbum')}
        kicker={isPhone ? undefined : lang(singlesOf ? 'MusicSingles' : 'MusicKindAlbum')}
        cover={(
          <MusicCover
            coverId={data.album?.coverId}
            toneId={albumId || `${singlesOf}-singles`}
            size={isPhone ? COVER_PHONE : COVER_DESK}
            glyph="disc"
            className={styles.heroCover}
          />
        )}
        subtitle={(
          <>
            {artistName && (
              <button type="button" className={styles.artistLink} data-music-artist-link onClick={handleArtist}>
                {artistName}
              </button>
            )}
            <div>{facts}</div>
          </>
        )}
        isPhone={isPhone}
        barActions={sendButton}
        actions={(
          <>
            <MusicPlayButtons isDisabled={!tracks.length} onPlay={handlePlayAll} onShuffle={handleShuffle} />
            {!isPhone && (
              <button type="button" className={kit.btn} data-music-album-to-chat onClick={handleSend}>
                {lang('MusicSendToChat')}
              </button>
            )}
            {albumId && <MusicOfflineCircle tracks={tracks} holder={{ kind: 'album', id: albumId }} />}
          </>
        )}
        onBack={goBackMusic}
      />
      {Boolean(tracks.length) && (
        <ul className={styles.tracks} data-music-tracks>
          {tracks.map((track, index) => (
            <MusicTrackRow
              key={track.id}
              track={track}
              index={index}
              number={track.trackNo || index + 1}
              isBare={isPhone && !singlesOf}
              columns={isPhone ? undefined : ['artist']}
              isCurrent={track.id === current?.id}
              isPlaying={player.isPlaying}
              canQueue
              canSaveOffline
              onPlay={handlePlay}
              onStar={handleStar}
              onSendToChat={onSendToChat}
            />
          ))}
        </ul>
      )}
      {Boolean(missing) && (
        <div className={buildClassName(kit.muted, kit.small)} data-music-album-missing>
          {lang('MusicAlbumOnServer', { count: tracks.length, total: missing }, { pluralValue: missing })}
          {' '}
          <button type="button" className={styles.inlineLink} onClick={handleFindRest}>
            {lang('MusicAlbumFindRest')}
          </button>
        </div>
      )}
      <MusicSendDialog playlist={asPlaylist} onClose={handleCloseSend} />
    </div>
  );
};

export default memo(MusicAlbumView);
