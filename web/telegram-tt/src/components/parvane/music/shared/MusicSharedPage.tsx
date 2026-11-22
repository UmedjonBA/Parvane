import {
  memo, useEffect, useMemo, useState,
} from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { MusicSharedItem } from '../../../../api/parvane/musicSharedApi';

import buildClassName from '../../../../util/buildClassName';
import { splitListTime } from '../musicFormat';
import {
  getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from '../musicPlayer';
import { loadPlaylistTracks } from '../musicPlaylists';
import { goBackMusic, openMusicView } from '../musicView';
import {
  canEditTracks, deleteSharedPlaylist, editSharedPlaylist, getSharedDetails, initialsOf, loadSharedPlaylist,
  moveSharedItem, removeSharedItem, toMusicTrack, watchSharedPlaylists,
} from './musicShared';

import useDerivedState from '../../../../hooks/useDerivedState';
import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ParvaneIcon from '../../../main/ParvaneIcon';
import PvEmpty from '../../notes/PvEmpty';
import PvSheet from '../../notes/PvSheet';
import PvSkeleton from '../../notes/PvSkeleton';
import MusicCover from '../MusicCover';
import MusicPlayButtons from '../MusicPlayButtons';
import MusicSectionHead from '../MusicSectionHead';
import MusicTrackRow from '../MusicTrackRow';
import MusicSharedMembers from './MusicSharedMembers';
import MusicSharedSendDialog from './MusicSharedSendDialog';

import kit from '../../notes/PvKit.module.scss';
import musicStyles from '../Music.module.scss';
import styles from './MusicShared.module.scss';

type OwnProps = {
  id: string;
  isPhone?: boolean;
};

// Лиц в строке участников и записей в «Последних добавлениях»
const FACES_MAX = 4;
const RECENT_MAX = 5;
const DAY_MS = 86400000;
const NAME_MAX = 120;

// Parvane (spec 041, MUSIC-3; доски `RpMusicB` «Общий плейлист», `ZdMusicX`, `DeskMusicMore`): страница общего
// плейлиста — «Общий плейлист · N треков · N участников», «Играть / Вперемешку», «Отправить в чат» (плейлист чата),
// строка «Кто добавляет треки · N» → участники, треки с «добавил …», «Последние добавления»; владельцу —
// «Переименовать», «Удалить плейлист». Правят треки владелец и «добавляет»; слушающий только слушает
const MusicSharedPage = ({ id, isPhone }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const allDetails = useDerivedState(getSharedDetails);
  const details = allDetails[id];
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const [isMissing, setIsMissing] = useState(false);
  const [isMembersOpen, openMembers, closeMembers] = useFlag();
  const [isSendOpen, openSend, closeSend] = useFlag();
  const [isRenameOpen, openRename, closeRename] = useFlag();
  const [isDeleteAsked, askDelete, cancelDelete] = useFlag();
  const [newName, setNewName] = useState('');
  // День для «сегодня / вчера» в «Последних добавлениях»
  const [today] = useState(() => Math.floor(Date.now() / DAY_MS));
  const [library, setLibrary] = useState<Map<string, ReturnType<typeof toMusicTrack>>>();

  useEffect(() => {
    setIsMissing(false);
    const stop = watchSharedPlaylists(id);
    void loadSharedPlaylist(id).then((isFound) => setIsMissing(!isFound));
    return stop;
  }, [id]);

  const items = details?.items;
  const idsKey = items?.map((item) => item.trackId).join('\n');
  // Сведения треков с сервера (обложки, любимое); трека, которого на сервере нет, — подписи из плейлиста
  useEffect(() => {
    if (!idsKey) return;
    void loadPlaylistTracks(idsKey.split('\n')).then(setLibrary).catch(() => undefined);
  }, [idsKey]);

  const tracks = useMemo(
    () => (items || []).map((item) => library?.get(item.trackId) || toMusicTrack(item)), [items, library],
  );
  const recent = useMemo(() => [...(items || [])].sort((a, b) => b.addedMs - a.addedMs).slice(0, RECENT_MAX), [items]);

  const source = { kind: 'playlist' as const, name: details?.playlist.name };
  const handlePlay = useLastCallback((index: number) => playTracks(tracks, index, { source }));
  const handlePlayAll = useLastCallback(() => playTracks(tracks, 0, { source }));
  const handleShuffle = useLastCallback(() => playTracks(tracks, 0, { isShuffled: true, source }));
  const handleStar = useLastCallback((track: ReturnType<typeof toMusicTrack>) => {
    void setTrackStarred(track, !track.isStarred);
  });

  const handleOpenRename = useLastCallback(() => {
    setNewName(details?.playlist.name || '');
    openRename();
  });
  const handleNewName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.currentTarget.value));
  const handleRename = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const name = newName.trim();
    if (!name) return;
    closeRename();
    if (!await editSharedPlaylist(id, { name })) showNotification({ message: lang('MusicSharedActionFailed') });
  });

  const handleDelete = useLastCallback(async () => {
    cancelDelete();
    if (await deleteSharedPlaylist(id)) goBackMusic();
    else showNotification({ message: lang('MusicSharedActionFailed') });
  });

  const handleGone = useLastCallback((personalId?: string) => {
    if (personalId) openMusicView({ kind: 'playlist', id: personalId });
    else goBackMusic();
  });

  const handleRemoveItem = useLastCallback((item: MusicSharedItem) => void removeSharedItem(id, item.id));
  const handleMove = useLastCallback((from: number, to: number) => void moveSharedItem(id, from, to));

  if (isMissing && !details) {
    return (
      <div className={musicStyles.view}>
        <MusicSectionHead title={lang('MusicSharedTitle')} isPhone={isPhone} onBack={goBackMusic} />
        <PvEmpty text={lang('MusicSharedMissing')} data-music-empty="shared" />
      </div>
    );
  }
  if (!details) return <PvSkeleton />;

  const { playlist, members } = details;
  const canEdit = canEditTracks(playlist.myRole);
  const isOwner = playlist.myRole === 'owner';
  const time = splitListTime(playlist.durationSecs);
  const editors = members.filter((member) => member.role !== 'listener');

  function describeAdded(item: MusicSharedItem) {
    const day = Math.floor(item.addedMs / DAY_MS);
    const when = day === today ? lang('MusicSharedToday') : day === today - 1 ? lang('MusicSharedYesterday')
      : new Date(item.addedMs).toLocaleDateString(lang.code, { day: 'numeric', month: 'short' });
    return `${lang('MusicAddedBy', { name: item.adderName })} · ${when}`;
  }

  const actions = (
    <>
      <MusicPlayButtons isDisabled={!tracks.length} onPlay={handlePlayAll} onShuffle={handleShuffle} />
      <button type="button" className={kit.btn} data-music-shared-to-chat onClick={openSend}>
        <ParvaneIcon name="send" isSmall />
        {lang('MusicSendToChat')}
      </button>
      {isOwner && (
        <>
          <button type="button" className={kit.btn} data-music-shared-rename onClick={handleOpenRename}>
            {lang('MusicPlaylistRename')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnDanger)}
            data-music-shared-delete
            onClick={isDeleteAsked ? handleDelete : askDelete}
          >
            {lang(isDeleteAsked ? 'MusicPlaylistDeleteConfirm' : 'MusicPlaylistDelete')}
          </button>
        </>
      )}
    </>
  );

  return (
    <div
      className={buildClassName(musicStyles.view, styles.page)}
      data-music-shared={playlist.id}
      data-role={playlist.myRole}
    >
      <MusicSectionHead
        kicker={lang(playlist.access === 'server' ? 'MusicSharedKickerServer' : 'MusicSharedKicker')}
        title={playlist.name}
        cover={<MusicCover toneId={playlist.id} size={72} glyph="list" className={musicStyles.heroCover} />}
        subtitle={(
          <span data-music-shared-meta>
            {[
              lang('MusicTracksCount', { count: playlist.trackCount }, { pluralValue: playlist.trackCount }),
              lang('MusicListTime', { hours: time.hours, minutes: time.minutes }),
              lang('MusicMembersCount', { count: playlist.memberCount }, { pluralValue: playlist.memberCount }),
            ].join(' · ')}
          </span>
        )}
        actions={actions}
        barTitle={lang('MusicSharedTitle')}
        isPhone={isPhone}
        onBack={goBackMusic}
      />
      <button type="button" className={styles.strip} data-music-members-open onClick={openMembers}>
        <span className={styles.stripFaces} aria-hidden>
          {editors.slice(0, FACES_MAX).map((member) => (
            <span key={member.address} className={buildClassName(styles.initials, styles.stripFace)}>
              {initialsOf(member.name || member.address)}
            </span>
          ))}
        </span>
        <span className={styles.memberText}>
          <span className={styles.name}>{lang('MusicSharedWhoAdds', { count: editors.length })}</span>
          <span className={styles.sub}>
            {isOwner ? lang('MusicMembersInvite') : lang('MusicSharedYourRole', {
              role: lang(playlist.myRole === 'listener' ? 'MusicRoleListener' : playlist.myRole === 'none'
                ? 'MusicRoleNone' : 'MusicRoleEditor'),
            })}
          </span>
        </span>
        <ParvaneIcon name="right" isSmall />
      </button>
      {!tracks.length && <PvEmpty text={lang('MusicSharedEmpty')} data-music-empty="shared-tracks" />}
      {Boolean(tracks.length) && (
        <ul className={musicStyles.tracks} data-music-shared-tracks>
          {tracks.map((track, index) => {
            const item = items[index];
            return (
              <MusicTrackRow
                key={item.id}
                track={track}
                index={index}
                number={index + 1}
                note={lang('MusicAddedBy', { name: item.adderName })}
                isCurrent={track.id === current?.id}
                isPlaying={player.isPlaying}
                canQueue
                canSaveOffline
                extra={canEdit ? {
                  removeLabel: lang('MusicPlaylistRemoveItem'),
                  onRemove: () => handleRemoveItem(item),
                  onMoveUp: index > 0 ? () => handleMove(index, index - 1) : undefined,
                  onMoveDown: index < tracks.length - 1 ? () => handleMove(index, index + 1) : undefined,
                } : undefined}
                onPlay={handlePlay}
                onStar={handleStar}
              />
            );
          })}
        </ul>
      )}
      {Boolean(recent.length) && (
        <section className={styles.recent} data-music-shared-recent>
          <div className={kit.caps}>{lang('MusicSharedRecent')}</div>
          {recent.map((item) => (
            <div key={item.id} className={styles.recentItem}>
              <span className={styles.name}>{item.title}</span>
              {` · ${describeAdded(item)}`}
            </div>
          ))}
        </section>
      )}
      <MusicSharedMembers isOpen={isMembersOpen} details={details} onClose={closeMembers} onGone={handleGone} />
      <MusicSharedSendDialog details={isSendOpen ? details : undefined} onClose={closeSend} />
      <PvSheet isOpen={isRenameOpen} title={lang('MusicPlaylistRename')} onClose={closeRename} onEnter={handleRename}>
        <form className={styles.form} onSubmit={handleRename}>
          <input
            className={kit.input}
            value={newName}
            maxLength={NAME_MAX}
            aria-label={lang('MusicPlaylistNameLabel')}
            autoFocus
            onChange={handleNewName}
          />
          <div className={styles.buttons}>
            <button type="button" className={kit.btn} onClick={closeRename}>{lang('Cancel')}</button>
            <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={!newName.trim()}>
              {lang('Save')}
            </button>
          </div>
        </form>
      </PvSheet>
    </div>
  );
};

export default memo(MusicSharedPage);
