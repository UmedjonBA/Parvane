import { memo, useEffect } from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import type { MusicSharedPlaylist } from '../../../api/parvane/musicSharedApi';
import type { ApiChat } from '../../../api/types';

import { getServerPlaylists, getSharedPlaylists, watchSharedPlaylists } from './shared/musicShared';
import { getOfflineHolds, getOfflineState } from './musicOffline';
import { getPlaylists, getPlaylistsStatus } from './musicPlaylists';
import { goBackMusic, openMusicView, openNewPlaylist } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import MusicCover from './MusicCover';
import MusicSectionHead from './MusicSectionHead';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicPlaylistList.module.scss';

type OwnProps = {
  isPhone?: boolean;
};

type Row = {
  key: string;
  view: { kind: 'playlist' | 'shared'; id: string };
  title: string;
  sub: string;
  glyph: 'list' | 'users' | 'chat';
  isHeld?: boolean;
};

const STATUS_KEYS = {
  'needs-linking': 'MusicPlaylistsNeedLinking',
  'no-key': 'MusicPlaylistsNoKey',
  offline: 'MusicPlaylistsOffline',
} as const;

// Parvane (макет «Музыки» 23 ноя, доска `MusicPlaylist-01`): плейлисты разделами — «Мои» (личные, «42 трека ·
// только вы»), «Общие» (на сервере, «общий · N участников»), «Плейлисты групп» (общий плейлист, привязанный к группе:
// «группа · N участников · 97»), сверх доски — «Общие плейлисты сервера» (открытые всем, где я не участник)
const MusicPlaylistList = ({ isPhone }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const status = useDerivedState(getPlaylistsStatus);
  const shared = useDerivedState(getSharedPlaylists);
  const open = useDerivedState(getServerPlaylists);
  // Перерисовка при смене «Загруженного»: отметки плейлистов читаются из `getOfflineHolds`
  useDerivedState(getOfflineState);
  const held = getOfflineHolds().playlists;

  useEffect(() => watchSharedPlaylists(), []);

  const handleNew = useLastCallback(() => openNewPlaylist());
  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id } = e.currentTarget.dataset;
    openMusicView({ kind: kind as 'playlist' | 'shared', id: id! });
  });

  // Общий плейлист группы: известен по сведениям групп, которые устройство уже читало
  const groupOf = findGroupPlaylists();
  const mine: Row[] = playlists.map((playlist) => ({
    key: `playlist:${playlist.id}`,
    view: { kind: 'playlist', id: playlist.id },
    title: playlist.name,
    sub: [lang('MusicTracksCount', { count: playlist.count }, { pluralValue: playlist.count }),
      lang('MusicOnlyYou')].join(' · '),
    glyph: 'list',
    isHeld: Boolean(held[playlist.id]),
  }));
  const sharedRow = (playlist: MusicSharedPlaylist): Row => {
    const group = groupOf[playlist.id];
    const members = group?.membersCount || playlist.memberCount;
    const sub = group
      ? [lang('MusicGroupMark', { count: members }, { pluralValue: members }), String(playlist.trackCount)]
      : [playlist.isInvited ? lang('MusicSharedInvitation') : lang('MusicSharedMark', {
        count: members,
      }, { pluralValue: members }), lang('MusicTracksCount', {
        count: playlist.trackCount,
      }, { pluralValue: playlist.trackCount })];
    return {
      key: `shared:${playlist.id}`,
      view: { kind: 'shared', id: playlist.id },
      title: playlist.name,
      sub: sub.join(' · '),
      glyph: group ? 'chat' : 'users',
    };
  };
  const common = shared.filter((playlist) => !groupOf[playlist.id]).map(sharedRow);
  const groups = shared.filter((playlist) => groupOf[playlist.id]).map(sharedRow);
  const server = open.map(sharedRow);

  function renderSection(title: string, rows: Row[], key: string) {
    if (!rows.length) return undefined;
    return (
      <section className={styles.section} data-music-playlists={key}>
        <div className={styles.caps}>{title}</div>
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className={styles.row}
            data-kind={row.view.kind}
            data-id={row.view.id}
            data-playlist={row.view.kind === 'playlist' ? row.view.id : undefined}
            data-shared={row.view.kind === 'shared' ? row.view.id : undefined}
            onClick={handleOpen}
          >
            <MusicCover toneId={row.view.id} size={48} glyph={row.glyph} className={styles.cover} />
            <span className={styles.text}>
              <span className={styles.title}>{row.title}</span>
              <span className={styles.sub}>{row.sub}</span>
            </span>
            {row.isHeld && (
              <span className={styles.held} role="img" aria-label={lang('MusicPlaylistOfflineMark')}>
                <ParvaneIcon name="downloaded" isSmall />
              </span>
            )}
            <ParvaneIcon name="right" isSmall className={styles.chevron} />
          </button>
        ))}
      </section>
    );
  }

  const isMineReady = status === 'ready' || status === 'loading';
  const isEmpty = !mine.length && !common.length && !groups.length && !server.length;

  return (
    <div className={styles.root}>
      <MusicSectionHead
        title={lang('MusicPlaylists')}
        barSubtitle={String(mine.length + common.length + groups.length)}
        isPhone={isPhone}
        barActions={(
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('MusicPlaylistNew')}
            data-music-new-playlist
            onClick={handleNew}
          >
            <ParvaneIcon name="plus" />
          </button>
        )}
        onBack={goBackMusic}
      />
      {!isMineReady && (
        <div className={styles.status} role="status" data-playlists-status={status}>{lang(STATUS_KEYS[status])}</div>
      )}
      {isMineReady && isEmpty && (
        <PvEmpty text={lang(status === 'loading' ? 'Loading' : 'MusicPlaylistsEmpty')} data-music-empty="playlists" />
      )}
      {renderSection(lang('MusicPlaylistsMineCaps'), mine, 'mine')}
      {renderSection(lang('MusicPlaylistsSharedCaps'), common, 'shared')}
      {renderSection(lang('MusicPlaylistsGroupsCaps'), groups, 'groups')}
      {renderSection(lang('MusicSharedServerSection'), server, 'server')}
    </div>
  );
};

/** Плейлист → группа, к которой он привязан (по прочитанным сведениям групп). */
function findGroupPlaylists() {
  const global = getGlobal();
  const out: Record<string, ApiChat> = {};
  Object.entries(global.chats.fullInfoById).forEach(([chatId, info]) => {
    const playlistId = info?.parvaneShared?.playlistId;
    const chat = global.chats.byId[chatId];
    if (playlistId && chat) out[playlistId] = chat;
  });
  return out;
}

export default memo(MusicPlaylistList);
