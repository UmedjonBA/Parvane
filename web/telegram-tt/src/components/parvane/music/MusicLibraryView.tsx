import { memo } from '../../../lib/teact/teact';

import type { MusicInfo } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { MusicViewKind } from './musicView';

import buildClassName from '../../../util/buildClassName';
import { getOfflineBytes, getOfflineState } from './musicOffline';
import { getPlaylists } from './musicPlaylists';
import { openMusicView, openNewPlaylist } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicPlaylistList from './MusicPlaylistList';
import { formatMusicSize } from './MusicSize';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  info: MusicInfo;
};

type Row = {
  kind: MusicViewKind;
  icon: ParvaneIconName;
  tone: string;
  title: string;
  hint: string;
  count?: number;
};

// Parvane (spec 041, доска `MusicLibrary`): вкладка «Библиотека» на телефоне — разделы строками с подписью и числом,
// под ними плейлисты с «+ Новый плейлист»
const MusicLibraryView = ({ info }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const offline = useDerivedState(getOfflineState);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: e.currentTarget.dataset.view as 'starred' });
  });

  const handleNew = useLastCallback(() => openNewPlaylist());

  const rows: Row[] = [
    {
      kind: 'starred',
      icon: 'heart',
      tone: styles.navToneRed,
      title: lang('MusicStarred'),
      hint: lang('MusicStarredHint'),
      count: info.starredCount,
    },
    {
      kind: 'playlists',
      icon: 'list',
      tone: styles.navToneAccent,
      title: lang('MusicPlaylists'),
      hint: lang('MusicPlaylistsHint'),
      count: playlists.length,
    },
    {
      kind: 'artists',
      icon: 'mic',
      tone: styles.navTonePurple,
      title: lang('MusicArtists'),
      hint: lang('MusicWholeLibrary'),
      count: info.libraryArtists,
    },
    {
      kind: 'albums',
      icon: 'disc',
      tone: styles.navToneGreen,
      title: lang('MusicAlbums'),
      hint: lang('MusicWholeLibrary'),
      count: info.libraryAlbums,
    },
    {
      kind: 'offline',
      icon: 'downloaded',
      tone: styles.navToneAqua,
      title: lang('MusicOffline'),
      hint: [lang('MusicOfflineHint'), formatMusicSize(lang, getOfflineBytes(offline))].join(' · '),
      count: offline.entries.length,
    },
  ];
  // «Добавлено мной» — функция сверх макета, строкой раздела (только со скачиванием)
  if (info.isFetchEnabled) {
    rows.push({
      kind: 'added',
      icon: 'upload',
      tone: styles.navToneAccent,
      title: lang('MusicAdded'),
      hint: lang('MusicAddedToday', { today: info.addedToday, perDay: info.addPerDay }),
    });
  }

  return (
    <>
      <div className={styles.libraryRows} data-music-library>
        {rows.map((row) => (
          <button key={row.kind} type="button" className={styles.libraryRow} data-view={row.kind} onClick={handleOpen}>
            <ParvaneIcon name={row.icon} className={row.tone} />
            <span className={styles.trackText}>
              <span className={styles.trackTitle}>{row.title}</span>
              <span className={buildClassName(kit.muted, kit.small)}>{row.hint}</span>
            </span>
            {Boolean(row.count) && <span className={buildClassName(kit.mono, kit.muted, kit.small)}>{row.count}</span>}
            <ParvaneIcon name="right" isSmall className={styles.chevron} />
          </button>
        ))}
      </div>
      <div className={buildClassName(kit.caps, styles.groupHead)}>
        <span className={kit.grow}>{lang('MusicPlaylists')}</span>
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicPlaylistNew')}
          data-music-new-playlist
          onClick={handleNew}
        >
          <ParvaneIcon name="plus" isSmall />
        </button>
      </div>
      <MusicPlaylistList />
    </>
  );
};

export default memo(MusicLibraryView);
