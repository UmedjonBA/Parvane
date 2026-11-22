import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { CloudRole } from '../../../api/parvane/v2/cloud';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { addressOfNick } from './cloudModel';
import { getPeerHandle, getPeerName } from './cloudPeople';
import {
  getCloudData, getCloudPlace, getContainer, setCloudPlace, showCloudNotice, unshareCloudFolder,
} from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';
import ConfirmDialog from '../../ui/ConfirmDialog';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import seg from '../notes/PvSegment.module.scss';
import styles from './CloudSheets.module.scss';

type OwnProps = {
  isOpen: boolean;
  containerId?: string;
  // Телефон (доска `PhFilesMore`): экран на весь экран, приглашённые отдельным разделом
  isNarrow?: boolean;
  onChanged: () => Promise<unknown>;
  onClose: NoneToVoidFunction;
};

type ShareRole = Exclude<CloudRole, 'owner'>;
// Чип роли участника — меню «Правка / Просмотр / Убрать из папки» (у приглашённого — «Отменить приглашение»)
type RoleChoice = ShareRole | 'remove';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const USER_CHAT_TYPES = ['users'] as const;
const SHARE_ROLES: ShareRole[] = ['editor', 'reader'];
const AVATAR_TONES = ['orange', 'purple', 'red', 'aqua', 'green'];
// Пока окно открыто и есть ждущие ответа — их список перечитывается (получатель принимает у себя)
const PENDING_POLL_MS = 5000;
const NO_PENDING: string[] = [];

function initialOf(name: string) {
  return (Array.from(name)[0] || '').toUpperCase();
}

// Экран доступа к совместной папке (доски `PhFilesMore`, `DkFilesDialogs`): ник и роль нового участника, участники
// с ролью-чипом (меню ролей и «Убрать из папки»), приглашённые; «Сделать личной» / «Закрыть доступ», выход
// (участник). На приглашение отвечают в строке списка. Сервер видит состав, но не имена и не содержимое файлов.
const CloudShareDialog = ({
  isOpen, containerId, isNarrow, onChanged, onClose,
}: OwnProps) => {
  const lang = useLang();
  const data = useDerivedState(getCloudData);
  const [newRole, setNewRole] = useState<ShareRole>('reader');
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [confirm, setConfirm] = useState<'remove' | 'leave' | 'private'>();
  // Есть ли текст в поле ника (само поле — без привязки к состоянию, значение читается из него)
  const [hasNick, setHasNick] = useState(false);
  const [nickError, setNickError] = useState<string>();
  // Приглашённые, ещё не принявшие приглашение (сервер владельца); `undefined` — не известно, все — участники
  const [pending, setPending] = useState<string[]>();
  const nickRef = useRef<HTMLInputElement>();

  // Окно готовится к вводу в кадре появления
  useLayoutEffect(() => {
    if (!isOpen) return;
    setNewRole('reader');
    setConfirm(undefined);
    setHasNick(false);
    setNickError(undefined);
    if (nickRef.current) nickRef.current.value = '';
  }, [isOpen, containerId]);

  const id = containerId;
  const container = getContainer(id, data);
  const isOwner = container?.role === 'owner';
  const memberCount = container?.members.length || 0;

  const loadPending = useLastCallback(async () => {
    if (!id || !isOwner) return;
    const list = await callParvane('parvaneCloudPendingInvites', { container: id })
      .catch(() => undefined) as string[] | undefined;
    setPending(list);
  });

  useEffect(() => {
    if (!isOpen || !isOwner) {
      setPending(undefined);
      return undefined;
    }
    void loadPending();
    const timer = window.setInterval(() => void loadPending(), PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isOpen, isOwner, id, memberCount, loadPending]);

  const pendingList = pending || NO_PENDING;
  const accepted = container ? container.members.filter((m) => !pendingList.includes(m.user)) : [];
  const invited = container ? container.members.filter((m) => pendingList.includes(m.user)) : [];
  const folderName = container?.name || lang('ParvaneCloudSharedFolder');
  const roleTitle = (role: CloudRole) => lang(
    role === 'owner' ? 'ParvaneCloudRoleOwner'
      : role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader',
  );

  const run = async (method: string, args: Record<string, unknown>) => {
    markBusy();
    try {
      const result = await callParvane(method, args).catch(() => undefined) as CloudResult | undefined;
      if (!result?.ok) showCloudNotice(result?.error || 'rejected');
      await onChanged();
      void loadPending();
      return result;
    } finally {
      unmarkBusy();
    }
  };

  const invite = (target: { chatId?: string; user?: string }) => run('parvaneCloudShare', {
    container: id,
    ...target,
    role: newRole,
    inviteText: lang('ParvaneCloudInviteText', { name: folderName, role: roleTitle(newRole).toLocaleLowerCase() }),
  });

  const handlePick = useLastCallback((chatId: string) => {
    closePicker();
    void invite({ chatId });
  });

  const handleNickInput = useLastCallback((e: React.FormEvent<HTMLInputElement>) => {
    setHasNick(Boolean(e.currentTarget.value.trim()));
    setNickError(undefined);
  });

  // «Ник собеседника»: приглашение по нику без чата с ним; ник своего сервера — `@nick`. Пустое поле на телефоне —
  // «Из контактов»
  const handleNickSubmit = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = nickRef.current?.value || '';
    if (!text.trim()) {
      if (isNarrow) openPicker();
      else nickRef.current?.focus();
      return;
    }
    const selfDomain = getCloudData()?.containers.find((c) => c.kind === 'root')?.owner.split('@')[1];
    const user = addressOfNick(text, selfDomain);
    if (!user) {
      setNickError(lang('ParvaneCloudNickInvalid'));
      return;
    }
    // Ник сверяется с сервером точным поиском: грант незнакомому адресу иначе долго ждал бы его ключей
    markBusy();
    const chatId = await callParvane('parvaneResolveExactAddress', { address: user })
      .catch(() => undefined) as string | undefined;
    unmarkBusy();
    if (!chatId) {
      setNickError(lang('ParvaneCloudNickNotFound'));
      return;
    }
    const result = await invite({ chatId });
    if (result?.ok) {
      if (nickRef.current) nickRef.current.value = '';
      setHasNick(false);
    } else {
      setNickError(lang('ParvaneCloudErrorRejected'));
    }
  });

  const handleNewRole = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setNewRole(e.currentTarget.dataset.newRole as ShareRole);
  });

  const handleMemberRole = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const user = e.currentTarget.dataset.user!;
    const choice = e.currentTarget.value as RoleChoice;
    if (choice === 'remove') {
      void run('parvaneCloudUnshare', { container: id, user });
      return;
    }
    void run('parvaneCloudShare', {
      container: id, user, role: choice, inviteText: '',
    });
  });

  const handleCancelInvite = (user: string) => () => {
    void run('parvaneCloudUnshare', { container: id, user });
  };

  // Папки больше нет в списке — подняться из неё
  const leavePlace = () => {
    const place = getCloudPlace();
    if (place.container === id) setCloudPlace(place.view ? { view: place.view } : {});
  };

  const handleConfirm = useLastCallback(async () => {
    if (confirm === 'private') {
      setConfirm(undefined);
      leavePlace();
      onClose();
      void unshareCloudFolder(id!, lang('ParvaneCloudSharedFolder'));
      return;
    }
    const method = confirm === 'remove' ? 'parvaneCloudRemoveShared' : 'parvaneCloudLeave';
    setConfirm(undefined);
    const result = await run(method, { container: id });
    if (!result?.ok) return;
    leavePlace();
    onClose();
  });

  // Телефон — «Сделать личной» (`PhFilesMore`), компьютер — «Закрыть доступ» (`DkFilesDialogs`)
  const privateKey = isNarrow ? 'ParvaneCloudMakePersonal' : 'ParvaneCloudMakePrivate';

  function renderRoleChip(user: string, role: CloudRole, isInvited?: boolean) {
    const name = getPeerName(user);
    return (
      <select
        className={buildClassName(styles.role, styles.roleChip)}
        value={role === 'editor' ? 'editor' : 'reader'}
        disabled={isBusy}
        aria-label={lang('ParvaneCloudRoleChange', { name })}
        data-user={user}
        onChange={handleMemberRole}
      >
        {/* Выбор — `selected` у пункта: `value` у `select` Teact ставит до пунктов, и выделялся первый */}
        {SHARE_ROLES.map((r) => (
          <option key={r} value={r} selected={r === (role === 'editor' ? 'editor' : 'reader')}>{roleTitle(r)}</option>
        ))}
        <option value="remove">
          {lang(isInvited ? 'ParvaneCloudInviteCancelFull' : 'ParvaneCloudRemoveFromFolder')}
        </option>
      </select>
    );
  }

  function renderMember(user: string, role: CloudRole, index: number, isInvited?: boolean) {
    const name = getPeerName(user);
    return (
      <div
        key={user}
        className={styles.member}
        role="listitem"
        data-member={isInvited ? undefined : user}
        data-invited={isInvited ? user : undefined}
        data-role={role}
      >
        <span className={styles.avatar} style={`--c: var(--pv-${AVATAR_TONES[index % AVATAR_TONES.length]})`}>
          {initialOf(name)}
        </span>
        <span className={styles.memberText}>
          <span className={styles.memberName} dir="auto">{name}</span>
          <span className={styles.memberSub} dir="ltr">
            {isInvited ? `${getPeerHandle(user)} · ${lang('ParvaneCloudInvitedMark')}` : getPeerHandle(user)}
          </span>
        </span>
        {renderRoleChip(user, role, isInvited)}
      </div>
    );
  }

  const roleHint = (
    <div className={styles.note}>
      <span className={styles.noteStrong}>{roleTitle('editor')}</span>
      {` — ${lang('ParvaneCloudRoleEditorNote')}. `}
      <span className={styles.noteStrong}>{roleTitle('reader')}</span>
      {` — ${lang('ParvaneCloudRoleReaderNote')}.`}
    </div>
  );

  return (
    <>
      <PvSheet
        isOpen={isOpen && !isPickerOpen}
        title={lang('ParvaneCloudShareTitle', { name: folderName })}
        className={styles.narrow}
        isPage
        startClose={isNarrow ? 'back' : undefined}
        onClose={onClose}
      >
        {container && (
          <div className={styles.share} data-container-id={container.id} data-role={container.role}>
            {isOwner && (
              <form className={styles.shareNick} onSubmit={handleNickSubmit} data-share-nick>
                <label className={styles.field}>
                  {lang('ParvaneCloudNickLabel')}
                  <span className={styles.shareNickRow}>
                    <input
                      ref={nickRef}
                      className={buildClassName(kit.input, styles.shareNickInput)}
                      placeholder="@nick"
                      aria-label={lang('ParvaneCloudNickLabel')}
                      aria-invalid={Boolean(nickError)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      enterKeyHint="send"
                      onInput={handleNickInput}
                    />
                    {!isNarrow && (
                      <span className={seg.root} role="group" aria-label={lang('KnowledgeFilesRole')}>
                        {SHARE_ROLES.map((role) => (
                          <button
                            key={role}
                            type="button"
                            className={buildClassName(seg.item, newRole === role && seg.itemOn)}
                            aria-pressed={newRole === role}
                            data-new-role={role}
                            onClick={handleNewRole}
                          >
                            {roleTitle(role)}
                          </button>
                        ))}
                      </span>
                    )}
                    <button
                      type="submit"
                      className={buildClassName(kit.btn, !isNarrow && kit.btnAcc)}
                      disabled={isBusy}
                      data-share-nick-submit
                    >
                      {lang(hasNick || !isNarrow ? 'ParvaneCloudNickInvite' : 'ParvaneCloudFromContacts')}
                    </button>
                  </span>
                </label>
                {nickError && <div className={kit.fieldError} role="alert">{nickError}</div>}
                {!isNarrow && (
                  <button type="button" className={styles.linkPlain} data-share-contacts onClick={openPicker}>
                    {lang('ParvaneCloudFromContacts')}
                  </button>
                )}
              </form>
            )}
            {isNarrow && (
              <h3 className={styles.caption}>
                {lang('ParvaneCloudMembers', { count: (isOwner ? accepted.length : container.members.length) + 1 })}
              </h3>
            )}
            <div className={styles.members} role="list">
              <div className={styles.member} role="listitem">
                <span className={styles.avatar}>
                  {isOwner ? lang('ParvaneCloudMeShort') : initialOf(getPeerName(container.owner))}
                </span>
                <span className={styles.memberText}>
                  <span className={styles.memberName} dir="auto">
                    {isOwner ? lang('ParvaneCloudYou') : getPeerName(container.owner)}
                  </span>
                  {(isNarrow || !isOwner) && (
                    <span className={styles.memberSub}>
                      {isOwner ? lang('ParvaneCloudFolderOwner') : getPeerHandle(container.owner)}
                    </span>
                  )}
                </span>
                <span className={styles.role} aria-label={lang('ParvaneCloudRoleOwnerLabel')}>
                  {roleTitle('owner')}
                </span>
              </div>
              {isOwner && accepted.map((m, index) => renderMember(m.user, m.role, index))}
              {/* Компьютер (`DkFilesDialogs`): приглашённый — в общем списке с пометкой «приглашён» */}
              {isOwner && !isNarrow && invited.map((m, index) => (
                renderMember(m.user, m.role, accepted.length + index, true)
              ))}
              {!isOwner && container.role && (
                <div className={styles.member} role="listitem">
                  <span className={styles.avatar} style="--c: var(--pv-purple)">{lang('ParvaneCloudMeShort')}</span>
                  <span className={styles.memberText}>
                    <span className={styles.memberName}>{lang('ParvaneCloudYou')}</span>
                  </span>
                  <span className={styles.role}>{roleTitle(container.role)}</span>
                </div>
              )}
            </div>
            {isOwner && !container.members.length && (
              <div className={styles.note}>{lang('ParvaneCloudNoMembers')}</div>
            )}
            {roleHint}
            {/* Телефон (`PhFilesMore`): приглашённые — отдельным разделом с «Отменить» */}
            {isOwner && isNarrow && invited.length > 0 && (
              <>
                <h3 className={styles.caption}>{lang('ParvaneCloudInvitations')}</h3>
                <div className={styles.members} role="list" data-invitations>
                  {invited.map((m) => (
                    <div
                      key={m.user}
                      className={styles.member}
                      role="listitem"
                      data-invited={m.user}
                      data-role={m.role}
                    >
                      <span className={styles.memberText}>
                        <span className={styles.memberName} dir="ltr">{getPeerHandle(m.user)}</span>
                        <span className={styles.memberSub}>
                          {`${lang('ParvaneCloudInviteWaiting')} · ${roleTitle(m.role)}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={buildClassName(styles.textDanger)}
                        disabled={isBusy}
                        data-invite-cancel
                        onClick={handleCancelInvite(m.user)}
                      >
                        {lang('ParvaneCloudInviteCancel')}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            <span className={styles.space} />
            <div className={buildClassName(styles.buttons, styles.buttonsColumn)}>
              {isOwner && (
                <button
                  type="button"
                  className={buildClassName(kit.btn, styles.buttonsStart)}
                  disabled={isBusy}
                  data-share-private
                  onClick={() => setConfirm('private')}
                >
                  {lang(privateKey)}
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  className={buildClassName(kit.btn, styles.danger)}
                  disabled={isBusy}
                  onClick={() => setConfirm('remove')}
                >
                  {lang('ParvaneCloudStopSharing')}
                </button>
              )}
              {!isOwner && (
                <button
                  type="button"
                  className={buildClassName(kit.btn, styles.danger, styles.buttonsStart)}
                  disabled={isBusy}
                  onClick={() => setConfirm('leave')}
                >
                  {lang('ParvaneCloudLeave')}
                </button>
              )}
              <button type="button" className={buildClassName(kit.btn, kit.btnAcc, kit.hideM)} onClick={onClose}>
                {lang('Done')}
              </button>
            </div>
          </div>
        )}
        {!container && id && <div className={kit.muted}>{lang('ParvaneCloudInviteGone')}</div>}
      </PvSheet>
      <RecipientPicker
        isOpen={isOpen && isPickerOpen}
        title={lang('ParvaneCloudShareAdd')}
        searchPlaceholder={lang('Search')}
        filter={USER_CHAT_TYPES}
        onSelectRecipient={handlePick}
        onClose={closePicker}
      />
      <ConfirmDialog
        isOpen={Boolean(confirm)}
        title={lang(
          confirm === 'private' ? privateKey
            : confirm === 'remove' ? 'ParvaneCloudStopSharing' : 'ParvaneCloudLeave',
        )}
        text={lang(
          confirm === 'private' ? 'ParvaneCloudMakePrivateConfirm'
            : confirm === 'remove' ? 'ParvaneCloudStopSharingConfirm' : 'ParvaneCloudLeaveConfirm',
        )}
        confirmLabel={lang(
          confirm === 'private' ? privateKey
            : confirm === 'remove' ? 'ParvaneCloudDelete' : 'ParvaneCloudLeave',
        )}
        confirmIsDestructive={confirm !== 'private'}
        confirmHandler={handleConfirm}
        onClose={() => setConfirm(undefined)}
      />
    </>
  );
};

export default memo(CloudShareDialog);
