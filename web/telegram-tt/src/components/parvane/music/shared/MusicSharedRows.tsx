import { memo, useEffect } from '../../../../lib/teact/teact';

import type { MusicSharedPlaylist } from '../../../../api/parvane/musicSharedApi';

import buildClassName from '../../../../util/buildClassName';
import { openMusicView } from '../musicView';
import { getServerPlaylists, getSharedPlaylists, watchSharedPlaylists } from './musicShared';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import MusicCover from '../MusicCover';

import kit from '../../notes/PvKit.module.scss';
import musicStyles from '../Music.module.scss';

type OwnProps = {
  // Ещё и раздел «Общие плейлисты сервера» (открытые всем, где я не участник)
  withServer?: boolean;
};

// Parvane (spec 041, доски `MusicLibrary`, `DeskMusic`): общие плейлисты строками после своих — «97 треков · общий,
// 14 участников»; позванный ещё не открывал — «приглашение». Нажатие открывает страницу общего плейлиста
const MusicSharedRows = ({ withServer }: OwnProps) => {
  const lang = useLang();
  const mine = useDerivedState(getSharedPlaylists);
  const open = useDerivedState(getServerPlaylists);

  useEffect(() => watchSharedPlaylists(), []);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'shared', id: e.currentTarget.dataset.shared! });
  });

  function renderRow(playlist: MusicSharedPlaylist) {
    const tracks = lang('MusicTracksCount', { count: playlist.trackCount }, { pluralValue: playlist.trackCount });
    const kind = playlist.isInvited ? lang('MusicSharedInvitation') : lang('MusicSharedMark', {
      count: playlist.memberCount,
    }, { pluralValue: playlist.memberCount });
    return (
      <li key={playlist.id} className={musicStyles.track}>
        <button
          type="button"
          className={musicStyles.trackMain}
          data-shared={playlist.id}
          data-shared-invited={playlist.isInvited || undefined}
          onClick={handleOpen}
        >
          <MusicCover toneId={playlist.id} size={40} glyph="users" className={musicStyles.trackCover} />
          <span className={musicStyles.trackText}>
            <span className={musicStyles.trackTitle}>{playlist.name}</span>
            <span className={buildClassName(kit.muted, kit.small)}>{`${tracks} · ${kind}`}</span>
          </span>
        </button>
      </li>
    );
  }

  return (
    <>
      {Boolean(mine.length) && <ul className={musicStyles.tracks} data-music-shared-list>{mine.map(renderRow)}</ul>}
      {withServer && Boolean(open.length) && (
        <>
          <div className={kit.caps}>{lang('MusicSharedServerSection')}</div>
          <ul className={musicStyles.tracks} data-music-server-list>{open.map(renderRow)}</ul>
        </>
      )}
    </>
  );
};

export default memo(MusicSharedRows);
