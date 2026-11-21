import { memo, useLayoutEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { MusicSharedDetails, MusicSharedMember } from '../../../../api/parvane/musicSharedApi';

import buildClassName from '../../../../util/buildClassName';
import {
  editSharedPlaylist, initialsOf, inviteToShared, leaveSharedPlaylist, makePlaylistPersonal, removeSharedMember,
  setSharedMemberRole,
} from './musicShared';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PvSheet from '../../notes/PvSheet';
import PvSwitch from '../../notes/PvSwitch';

import kit from '../../notes/PvKit.module.scss';
import styles from './MusicShared.module.scss';

type OwnProps = {
  isOpen: boolean;
  details: MusicSharedDetails;
  onClose: NoneToVoidFunction;
  // Плейлист закрыт для всех (стал личным) либо я вышел — страница закрывается
  onGone: (personalId?: string) => void;
};

type Role = 'editor' | 'listener';

const INVITE_ERRORS = {
  unknown: 'MusicMembersUnknownNick',
  failed: 'MusicMembersInviteFailed',
} as const;

// Parvane (spec 041, доски `ZdMusicX`, `RpMusicB`): «Участники плейлиста» — владелец зовёт по нику с ролью
// «Добавляет» / «Слушает», меняет роль, убирает участника, открывает плейлист всем на сервере, «Закрыть для всех»
// (плейлист становится личным). Участник видит список и может выйти
const MusicSharedMembers = ({
  isOpen, details, onClose, onGone,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const { playlist, members } = details;
  const isOwner = playlist.myRole === 'owner';
  const [nick, setNick] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [error, setError] = useState<keyof typeof INVITE_ERRORS>();
  const [isBusy, setIsBusy] = useState(false);

  // Поле пустое в кадр появления окна
  useLayoutEffect(() => {
    if (!isOpen) return;
    setNick('');
    setError(undefined);
  }, [isOpen]);

  const handleNick = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNick(e.currentTarget.value);
    setError(undefined);
  });
  const handleRole = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setRole(e.currentTarget.value as Role);
  });

  const handleInvite = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!nick.trim() || isBusy) return;
    setIsBusy(true);
    const result = await inviteToShared(playlist.id, nick, role);
    setIsBusy(false);
    if (result === 'unknown' || !result) {
      setError(result === 'unknown' ? 'unknown' : 'failed');
      return;
    }
    setNick('');
  });

  const handleMemberRole = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    void setSharedMemberRole(playlist.id, e.currentTarget.dataset.address!, e.currentTarget.value as Role);
  });
  const handleRemove = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void removeSharedMember(playlist.id, e.currentTarget.dataset.address!);
  });
  const handleServerWide = useLastCallback((isOn: boolean) => {
    void editSharedPlaylist(playlist.id, { access: isOn ? 'server' : 'members' });
  });
  const handleClose = useLastCallback(async () => {
    const personalId = await makePlaylistPersonal(playlist.id);
    if (!personalId) {
      showNotification({ message: lang('MusicSharedActionFailed') });
      return;
    }
    onClose();
    onGone(personalId);
  });
  const handleLeave = useLastCallback(async () => {
    if (!await leaveSharedPlaylist(playlist.id)) {
      showNotification({ message: lang('MusicSharedActionFailed') });
      return;
    }
    onClose();
    onGone();
  });

  function describe(member: MusicSharedMember) {
    if (member.role === 'owner') {
      return member.isMe ? lang('MusicMemberYouOwner') : lang('MusicMemberOwner');
    }
    if (member.isInvited) return lang('MusicMemberInvited');
    return lang('MusicMemberAdded', { count: member.addedCount }, { pluralValue: member.addedCount });
  }

  function renderMember(member: MusicSharedMember) {
    const canManage = isOwner && member.role !== 'owner';
    return (
      <li key={member.address} className={styles.member} data-music-member={member.address} data-role={member.role}>
        <span className={styles.initials} aria-hidden>{initialsOf(member.name || member.address)}</span>
        <span className={styles.memberText}>
          <span className={styles.name}>{member.isMe ? lang('MusicMemberMe') : member.name}</span>
          <span className={styles.sub}>{describe(member)}</span>
        </span>
        {canManage ? (
          <>
            <select
              className={styles.role}
              value={member.role}
              aria-label={lang('MusicMemberRoleOf', { name: member.name })}
              data-address={member.address}
              onChange={handleMemberRole}
            >
              <option value="editor">{lang('MusicRoleEditor')}</option>
              <option value="listener">{lang('MusicRoleListener')}</option>
            </select>
            <button
              type="button"
              className={kit.btnGhost}
              data-address={member.address}
              data-music-member-remove
              onClick={handleRemove}
            >
              {lang('MusicMemberRemove')}
            </button>
          </>
        ) : member.role !== 'owner' && (
          <span className={styles.sub}>
            {lang(member.role === 'listener' ? 'MusicRoleListener' : 'MusicRoleEditor')}
          </span>
        )}
      </li>
    );
  }

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('MusicMembersTitle', { name: playlist.name })}
      onClose={onClose}
    >
      <div className={styles.form} data-music-members>
        <span className={styles.hint}>
          {lang(playlist.access === 'server' ? 'MusicMembersServerHint' : 'MusicMembersOnlyHint')}
        </span>
        {isOwner && (
          <form className={styles.invite} onSubmit={handleInvite}>
            <input
              className={buildClassName(kit.input, styles.inviteInput)}
              value={nick}
              placeholder="@nick"
              aria-label={lang('MusicMembersInvite')}
              data-music-invite-nick
              onChange={handleNick}
            />
            <select className={styles.role} value={role} aria-label={lang('MusicMemberRole')} onChange={handleRole}>
              <option value="editor">{lang('MusicRoleEditor')}</option>
              <option value="listener">{lang('MusicRoleListener')}</option>
            </select>
            <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={!nick.trim() || isBusy}>
              {lang('MusicMembersInviteButton')}
            </button>
          </form>
        )}
        {error && (
          <div className={styles.error} role="alert" data-music-invite-error={error}>{lang(INVITE_ERRORS[error])}</div>
        )}
        <ul className={styles.members}>{members.map(renderMember)}</ul>
        {isOwner && (
          <PvSwitch isOn={playlist.access === 'server'} data-music-server-wide onChange={handleServerWide}>
            <span>{lang('MusicMembersServerWide')}</span>
          </PvSwitch>
        )}
        <div className={styles.buttons}>
          {isOwner ? (
            <button type="button" className={kit.btnDanger} data-music-make-personal onClick={handleClose}>
              {lang('MusicMembersCloseForAll')}
            </button>
          ) : playlist.myRole !== 'none' && (
            <button type="button" className={kit.btnDanger} data-music-leave onClick={handleLeave}>
              {lang('MusicSharedLeave')}
            </button>
          )}
          <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={onClose}>
            {lang('Done')}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(MusicSharedMembers);
