import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { CloudRole } from '../../../api/parvane/v2/cloud';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { validateName } from './cloudModel';
import {
  getCloudData, getCloudLinks, getCloudPlace, getContainer, linkOfSource, setCloudPlace, showCloudNotice,
  unshareCloudFolder,
} from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';
import ConfirmDialog from '../../ui/ConfirmDialog';
import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';
import CloudLinkBlock from './CloudLinkBlock';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Не задан — создание новой совместной папки
  containerId?: string;
  onChanged: () => Promise<unknown>;
  onClose: NoneToVoidFunction;
};

type ShareRole = Exclude<CloudRole, 'owner'>;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const USER_CHAT_TYPES = ['users'] as const;
const SHARE_ROLES: ShareRole[] = ['reader', 'editor'];

function nameOf(address: string) {
  return address.split('@')[0];
}

// Шторка доступа к совместной папке: создание, участники и их права «Просмотр / Правка» (владелец),
// выход (участник). На приглашение отвечают в строке списка. Сервер видит состав, но не имена и не
// содержимое файлов.
const CloudShareDialog = ({
  isOpen, containerId, onChanged, onClose,
}: OwnProps) => {
  const lang = useLang();
  const data = useDerivedState(getCloudData);
  const links = useDerivedState(getCloudLinks);
  const [createdId, setCreatedId] = useState<string>();
  const [name, setName] = useState('');
  const [hasTried, setHasTried] = useState(false);
  const [newRole, setNewRole] = useState<ShareRole>('reader');
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [confirm, setConfirm] = useState<'remove' | 'leave' | 'private'>();
  const nameRef = useRef<HTMLInputElement>();

  useEffect(() => {
    if (!isOpen) return;
    setCreatedId(undefined);
    setName('');
    setHasTried(false);
    setNewRole('reader');
    setConfirm(undefined);
  }, [isOpen, containerId]);

  const id = containerId || createdId;
  const container = getContainer(id, data);
  const isOwner = container?.role === 'owner';
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
      return result;
    } finally {
      unmarkBusy();
    }
  };

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  });

  const handleCreate = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const value = (nameRef.current?.value ?? name).trim();
    setName(value);
    setHasTried(true);
    if (validateName(value)) return;
    const result = await run('parvaneCloudCreateShared', { name: value }) as
      CloudResult<{ container: string }> | undefined;
    if (result?.ok) setCreatedId(result.container);
  });

  const handlePick = useLastCallback((chatId: string) => {
    closePicker();
    const roleText = roleTitle(newRole).toLocaleLowerCase();
    void run('parvaneCloudShare', {
      container: id,
      chatId,
      role: newRole,
      inviteText: lang('ParvaneCloudInviteText', { name: folderName, role: roleText }),
    });
  });

  const handleNewRole = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setNewRole(e.currentTarget.value as ShareRole);
  });

  const handleMemberRole = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    void run('parvaneCloudShare', {
      container: id, user: e.currentTarget.dataset.user, role: e.currentTarget.value, inviteText: '',
    });
  });

  const handleRemoveMember = (user: string) => () => {
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

  const nameProblem = hasTried ? validateName(name.trim()) : undefined;
  const nameError = !nameProblem ? undefined
    : nameProblem === 'empty' ? lang('ParvaneCloudErrorNameEmpty')
      : nameProblem === 'too-long' ? lang('ParvaneCloudErrorNameLong') : lang('ParvaneCloudErrorNameChars');

  return (
    <>
      <PvSheet
        isOpen={isOpen && !isPickerOpen}
        title={container ? lang('ParvaneCloudShareTitle', { name: folderName }) : lang('ParvaneCloudNewShared')}
        onClose={onClose}
      >
        {!container && !id && (
          <>
            <form className={styles.nameForm} onSubmit={handleCreate}>
              <input
                ref={nameRef}
                id="parvane-cloud-shared-name"
                className={kit.input}
                value={name}
                placeholder={lang('ParvaneCloudFolderName')}
                aria-label={lang('ParvaneCloudFolderName')}
                aria-invalid={Boolean(nameError)}
                autoComplete="off"
                onChange={handleNameChange}
              />
              <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={isBusy}>
                {lang('ParvaneCloudCreate')}
              </button>
            </form>
            {nameError && <div className={kit.fieldError} role="alert">{nameError}</div>}
            <div className={buildClassName(kit.muted, kit.small)}>{lang('KnowledgeFilesShareNote')}</div>
          </>
        )}
        {container && (
          <div className={styles.share} data-container-id={container.id} data-role={container.role}>
            <div className={buildClassName(kit.muted, kit.small)}>
              {isOwner ? lang('KnowledgeFilesShareNote') : (
                `${lang('ParvaneCloudSharedBy', { name: nameOf(container.owner) })}${
                  container.role ? ` · ${roleTitle(container.role)}` : ''}`
              )}
            </div>
            {isOwner && (
              <div className={styles.shareAdd}>
                <select
                  className={buildClassName(kit.input, styles.roleSelect)}
                  value={newRole}
                  aria-label={lang('KnowledgeFilesRole')}
                  title={lang(newRole === 'editor' ? 'ParvaneCloudRoleEditorHint' : 'ParvaneCloudRoleReaderHint')}
                  data-new-role
                  onChange={handleNewRole}
                >
                  {SHARE_ROLES.map((role) => <option key={role} value={role}>{roleTitle(role)}</option>)}
                </select>
                <span className={buildClassName(kit.muted, kit.small, kit.grow)}>
                  {lang(newRole === 'editor' ? 'ParvaneCloudRoleEditorHint' : 'ParvaneCloudRoleReaderHint')}
                </span>
                <button
                  type="button"
                  className={buildClassName(kit.btn, kit.btnAcc)}
                  disabled={isBusy}
                  onClick={openPicker}
                >
                  {lang('ParvaneCloudShareAdd')}
                </button>
              </div>
            )}
            {isOwner && (
              <div className={styles.members} role="list">
                {container.members.map((m) => (
                  <div
                    key={m.user}
                    className={styles.plainRow}
                    role="listitem"
                    data-member={m.user}
                    data-role={m.role}
                  >
                    <span className={buildClassName(kit.ava, kit.avaM, kit.avaRound)} style="--c: var(--pv-purple)">
                      {(Array.from(nameOf(m.user))[0] || '').toUpperCase()}
                    </span>
                    <span className={buildClassName(kit.rowText, kit.ttl)} dir="auto">{nameOf(m.user)}</span>
                    <select
                      className={buildClassName(kit.input, styles.roleSelect, styles.roleSelectSmall)}
                      value={m.role === 'editor' ? 'editor' : 'reader'}
                      disabled={isBusy}
                      aria-label={`${lang('KnowledgeFilesRole')}: ${nameOf(m.user)}`}
                      data-user={m.user}
                      onChange={handleMemberRole}
                    >
                      {SHARE_ROLES.map((role) => <option key={role} value={role}>{roleTitle(role)}</option>)}
                    </select>
                    <button
                      type="button"
                      className={kit.ib}
                      disabled={isBusy}
                      aria-label={lang('ParvaneCloudRemoveMember')}
                      onClick={handleRemoveMember(m.user)}
                    >
                      <PvIcon name="x" isSmall />
                    </button>
                  </div>
                ))}
                {!container.members.length && (
                  <div className={kit.muted}>{lang('ParvaneCloudNoMembers')}</div>
                )}
              </div>
            )}
            {/* Ссылка для людей без аккаунта (spec 022): снимок всей папки, создаёт владелец либо редактор */}
            {(isOwner || container.role === 'editor') && (
              <CloudLinkBlock
                link={linkOfSource(links, { container: container.id })}
                source={{ container: container.id, name: folderName }}
                hasHeading
              />
            )}
            <div className={kit.sheetButtons}>
              {isOwner && (
                <button
                  type="button"
                  className={kit.btn}
                  disabled={isBusy}
                  onClick={() => setConfirm('private')}
                >
                  {lang('ParvaneCloudMakePrivate')}
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  className={buildClassName(kit.btn, kit.btnDanger)}
                  disabled={isBusy}
                  onClick={() => setConfirm('remove')}
                >
                  {lang('ParvaneCloudStopSharing')}
                </button>
              )}
              {!isOwner && (
                <button
                  type="button"
                  className={buildClassName(kit.btn, kit.btnDanger)}
                  disabled={isBusy}
                  onClick={() => setConfirm('leave')}
                >
                  {lang('ParvaneCloudLeave')}
                </button>
              )}
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
          confirm === 'private' ? 'ParvaneCloudMakePrivate'
            : confirm === 'remove' ? 'ParvaneCloudStopSharing' : 'ParvaneCloudLeave',
        )}
        text={lang(
          confirm === 'private' ? 'ParvaneCloudMakePrivateConfirm'
            : confirm === 'remove' ? 'ParvaneCloudStopSharingConfirm' : 'ParvaneCloudLeaveConfirm',
        )}
        confirmLabel={lang(
          confirm === 'private' ? 'ParvaneCloudMakePrivate'
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
