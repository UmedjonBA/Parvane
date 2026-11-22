import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { MusicSharedPlaylist } from '../../../api/parvane/musicSharedApi';
import type { ApiChat } from '../../../api/types';

import { selectChatFullInfo } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { openFiles } from '../../../util/parvaneSection';
import { callApi } from '../../../api/gramjs';
import {
  getCloudData, getContainer, getNodes, loadCloud, setCloudPlace,
} from '../../parvane/cloud/cloudStore';
import { goToMusicView } from '../../parvane/music/musicView';
import {
  ensureJoinKey, getSharedPlaylists, joinSharedPlaylist, refreshSharedPlaylists,
} from '../../parvane/music/shared/musicShared';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../../parvane/notes/PvSheet';

import styles from './GroupInfo.module.scss';

type OwnProps = {
  chat: ApiChat;
  shared?: { folder?: string; playlistId?: string; playlistKey?: string };
  // Вправе менять сведения группы — привязывает и снимает папку и плейлист
  canChange?: boolean;
  currentUserId?: string;
};

type Picker = 'folder' | 'playlist';

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

// Parvane (доска `ZpChat2`, «Общее в группе»): общая папка «Файлов» и общий плейлист «Музыки», привязанные к группе
// записью её журнала (`SetShared`). Строка ведёт в модуль; тот, кто вправе менять сведения группы, выбирает папку
// и плейлист из своих. Доступ к папке выдаёт её владелец: при привязке он зовёт нынешних участников группы
const GroupInfoShared = ({
  chat, shared, canChange, currentUserId,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [picker, setPicker] = useState<Picker>();
  const cloud = useDerivedState(getCloudData);
  const playlists = useDerivedState(getSharedPlaylists);
  const [knownPlaylist, setKnownPlaylist] = useState<MusicSharedPlaylist>();
  const folderId = shared?.folder;
  const playlistId = shared?.playlistId;
  const needsLists = Boolean(folderId || playlistId || canChange);

  useEffect(() => {
    if (!needsLists) return;
    void loadCloud(currentUserId);
    void refreshSharedPlaylists();
  }, [needsLists, currentUserId]);

  // Плейлист, открытый всем на сервере: имя и число треков сервер отдаёт и не состоящему в нём. Плейлист
  // «для выбранных» до вступления не виден — строка остаётся без названия, вступление — нажатием
  useEffect(() => {
    setKnownPlaylist(undefined);
    if (!playlistId) return;
    void (callParvane('parvaneMusicSharedGet', { id: playlistId }) as Promise<{ playlist?: MusicSharedPlaylist }>)
      .then((details) => setKnownPlaylist(details?.playlist))
      .catch(() => undefined);
  }, [playlistId]);

  // Приглашение, на которое ещё не ответили, доступом не считается
  const container = getContainer(folderId, cloud);
  const folder = container && container.kind !== 'invite' ? container : undefined;
  const fileCount = folder
    ? getNodes(folderId, cloud).filter((n) => n.kind === 'file' && !n.trashed).length : undefined;
  const playlist = playlists.find(({ id }) => id === playlistId) || knownPlaylist;

  const handleOpenFolder = useLastCallback(() => {
    if (!folderId) {
      setPicker('folder');
      return;
    }
    if (!folder) return;
    setCloudPlace({ view: 'shared', container: folderId });
    openFiles();
  });

  const handleOpenPlaylist = useLastCallback(async () => {
    if (!playlistId) {
      setPicker('playlist');
      return;
    }
    const isMember = playlists.some(({ id }) => id === playlistId);
    const joined = isMember ? { id: playlistId } : await joinSharedPlaylist(playlistId, shared?.playlistKey || '');
    if (!joined) {
      showNotification({ message: lang('ParvaneGroupSharedFailed') });
      return;
    }
    goToMusicView({ kind: 'shared', id: joined.id });
  });

  const closePicker = useLastCallback(() => setPicker(undefined));

  const save = useLastCallback(async (next: { folder?: string; playlistId?: string; playlistKey?: string }) => {
    closePicker();
    const isDone = await callParvane('parvaneSetGroupShared', { chat, ...next }).catch(() => undefined);
    if (!isDone) showNotification({ message: lang('ParvaneGroupSharedFailed') });
    return Boolean(isDone);
  });

  const handlePickFolder = useLastCallback(async (id?: string) => {
    const isDone = await save({ folder: id, playlistId, playlistKey: shared?.playlistKey });
    if (!isDone || !id) return;
    // Владелец папки зовёт нынешних участников группы; уже позванным повторный вызов ничего не меняет
    const invited = new Set((getContainer(id)?.members || []).map(({ user }) => user));
    const members = selectChatFullInfo(getGlobal(), chat.id)?.members || [];
    for (const { userId } of members) {
      if (userId === currentUserId) continue;
      const result = await callParvane('parvaneCloudShare', {
        container: id,
        chatId: userId,
        role: 'editor',
        inviteText: lang('ParvaneGroupSharedInvite', { group: chat.title }),
      }).catch(() => undefined) as CloudResult | undefined;
      if (!result?.ok && !invited.size) break;
    }
  });

  const handlePickPlaylist = useLastCallback(async (id?: string) => {
    const key = id ? await ensureJoinKey(id) : undefined;
    await save({ folder: folderId, playlistId: id, playlistKey: key });
  });

  const rowClass = buildClassName(styles.row, styles.rowButton);
  // Свои общие папки («Общие папки» в «Файлах»)
  const ownFolders = (cloud?.containers || []).filter((c) => c.kind === 'owned');
  const ownPlaylists = playlists.filter(({ myRole }) => myRole === 'owner');
  const noneTitle = lang('ParvaneGroupSharedPickNone');

  function renderPickRow(key: string, title: string, isOn: boolean, onPick: NoneToVoidFunction) {
    return (
      <button
        key={key}
        type="button"
        className={rowClass}
        role="radio"
        aria-checked={isOn}
        data-group-shared-pick={key}
        onClick={onPick}
      >
        <span className={styles.text}>{title}</span>
        {isOn && <span className={styles.value} aria-hidden>✓</span>}
      </button>
    );
  }

  return (
    <>
      {(folderId || canChange) && (
        <button
          type="button"
          className={rowClass}
          disabled={Boolean(folderId) && !folder}
          data-group-shared="folder"
          data-group-shared-state={!folderId ? 'none' : folder ? 'open' : 'no-access'}
          onClick={handleOpenFolder}
        >
          <span className={styles.text}>
            <span className={styles.title}>
              {folder ? lang('ParvaneGroupSharedFolder', { name: folder.name }) : lang('ParvaneGroupSharedFolderNone')}
            </span>
            <span className={styles.sub}>
              {lang(!folderId ? 'ParvaneGroupSharedNotSet'
                : folder ? 'ParvaneGroupSharedFolderSub' : 'ParvaneGroupSharedFolderNoAccess')}
            </span>
          </span>
          {fileCount !== undefined && <span className={styles.value} data-group-shared-count>{fileCount}</span>}
          {canChange && folderId && (
            <span
              className={styles.value}
              role="button"
              tabIndex={0}
              data-group-shared-change="folder"
              onClick={(e) => {
                e.stopPropagation();
                setPicker('folder');
              }}
            >
              {lang('ParvaneAccountChange')}
            </span>
          )}
          <span className={styles.chevron} aria-hidden>›</span>
        </button>
      )}
      {(playlistId || canChange) && (
        <button
          type="button"
          className={rowClass}
          data-group-shared="playlist"
          data-group-shared-state={playlistId ? 'open' : 'none'}
          onClick={handleOpenPlaylist}
        >
          <span className={styles.text}>
            <span className={styles.title}>
              {playlist ? lang('ParvaneGroupSharedPlaylist', { name: playlist.name })
                : lang('ParvaneGroupSharedPlaylistNone')}
            </span>
            <span className={styles.sub}>
              {lang(playlistId ? 'ParvaneGroupSharedPlaylistSub' : 'ParvaneGroupSharedNotSet')}
            </span>
          </span>
          {playlist && <span className={styles.value} data-group-shared-count>{playlist.trackCount}</span>}
          {canChange && playlistId && (
            <span
              className={styles.value}
              role="button"
              tabIndex={0}
              data-group-shared-change="playlist"
              onClick={(e) => {
                e.stopPropagation();
                setPicker('playlist');
              }}
            >
              {lang('ParvaneAccountChange')}
            </span>
          )}
          <span className={styles.chevron} aria-hidden>›</span>
        </button>
      )}
      <PvSheet
        isOpen={Boolean(picker)}
        title={lang(picker === 'playlist' ? 'ParvaneGroupSharedPickPlaylist' : 'ParvaneGroupSharedPickFolder')}
        isTight
        onClose={closePicker}
      >
        <div className={styles.grp} role="radiogroup" data-group-shared-picker={picker}>
          {picker === 'folder' && (
            <>
              {renderPickRow('none', noneTitle, !folderId, () => handlePickFolder(undefined))}
              {ownFolders.map((c) => renderPickRow(c.id, c.name, c.id === folderId, () => handlePickFolder(c.id)))}
            </>
          )}
          {picker === 'playlist' && (
            <>
              {renderPickRow('none', noneTitle, !playlistId, () => handlePickPlaylist(undefined))}
              {ownPlaylists.map((p) => (
                renderPickRow(p.id, p.name, p.id === playlistId, () => handlePickPlaylist(p.id))
              ))}
            </>
          )}
        </div>
        {picker === 'folder' && !ownFolders.length && (
          <p className={styles.pickHint}>{lang('ParvaneGroupSharedPickFolderEmpty')}</p>
        )}
        {picker === 'playlist' && !ownPlaylists.length && (
          <p className={styles.pickHint}>{lang('ParvaneGroupSharedPickPlaylistEmpty')}</p>
        )}
      </PvSheet>
    </>
  );
};

export default memo(GroupInfoShared);
