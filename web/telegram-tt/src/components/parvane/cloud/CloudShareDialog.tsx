import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { CloudRole } from '../../../api/parvane/v2/cloud';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { validateName } from './cloudModel';
import {
  getCloudData, getCloudPlace, getContainer, setCloudPlace, showCloudNotice, unshareCloudFolder,
} from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import InputText from '../../ui/InputText';
import Modal from '../../ui/Modal';

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

function nameOf(address: string) {
  return address.split('@')[0];
}

// Совместная папка: создание, участники и их роли (владелец), выход
// (участник). На приглашение отвечают в строке списка. Сервер видит состав,
// но не имена и не содержимое файлов.
const CloudShareDialog = ({
  isOpen, containerId, onChanged, onClose,
}: OwnProps) => {
  const lang = useLang();
  const data = useDerivedState(getCloudData);
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

  const handleSetRole = (user: string, role: ShareRole) => () => {
    void run('parvaneCloudShare', {
      container: id, user, role, inviteText: '',
    });
  };

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
      <Modal
        isOpen={isOpen && !isPickerOpen}
        title={container ? lang('ParvaneCloudShareTitle', { name: folderName }) : lang('ParvaneCloudNewShared')}
        className={styles.dialog}
        hasCloseButton
        onClose={onClose}
      >
        {!container && !id && (
          <form className={styles.dialogForm} onSubmit={handleCreate}>
            <InputText
              ref={nameRef}
              id="parvane-cloud-shared-name"
              label={lang('ParvaneCloudFolderName')}
              value={name}
              error={nameError}
              onChange={handleNameChange}
            />
            <div className="dialog-buttons">
              <Button className="confirm-dialog-button" isText disabled={isBusy} onClick={handleCreate}>
                {lang('ParvaneCloudCreate')}
              </Button>
              <Button className="confirm-dialog-button" isText onClick={onClose}>{lang('ParvaneCloudCancel')}</Button>
            </div>
          </form>
        )}
        {container && (
          <div className={styles.share} data-container-id={container.id} data-role={container.role}>
            {!isOwner && (
              <div className={styles.shareLine}>
                {lang('ParvaneCloudSharedBy', { name: nameOf(container.owner) })}
                {container.role && ` · ${roleTitle(container.role)}`}
              </div>
            )}
            {isOwner && (
              <div className={styles.members} role="list">
                {container.members.map((m) => (
                  <div key={m.user} className={styles.member} role="listitem" data-member={m.user} data-role={m.role}>
                    <div className={styles.memberName} dir="auto">{nameOf(m.user)}</div>
                    <div className={styles.roleSwitch} role="radiogroup">
                      {(['reader', 'editor'] as const).map((role) => (
                        <button
                          key={role}
                          type="button"
                          role="radio"
                          aria-checked={m.role === role}
                          disabled={isBusy}
                          className={buildClassName(styles.roleOption, m.role === role && styles.roleOptionOn)}
                          onClick={m.role === role ? undefined : handleSetRole(m.user, role)}
                        >
                          {roleTitle(role)}
                        </button>
                      ))}
                    </div>
                    <Button
                      round
                      size="tiny"
                      color="translucent"
                      iconName="close"
                      disabled={isBusy}
                      ariaLabel={lang('ParvaneCloudRemoveMember')}
                      onClick={handleRemoveMember(m.user)}
                    />
                  </div>
                ))}
                {!container.members.length && (
                  <div className={styles.dialogEmpty}>{lang('ParvaneCloudNoMembers')}</div>
                )}
              </div>
            )}
            {isOwner && (
              <div className={styles.shareAdd}>
                <div className={styles.roleSwitch} role="radiogroup" aria-label={lang('ParvaneCloudShareAdd')}>
                  {(['reader', 'editor'] as const).map((role) => (
                    <button
                      key={role}
                      type="button"
                      role="radio"
                      aria-checked={newRole === role}
                      className={buildClassName(styles.roleOption, newRole === role && styles.roleOptionOn)}
                      title={lang(role === 'editor' ? 'ParvaneCloudRoleEditorHint' : 'ParvaneCloudRoleReaderHint')}
                      onClick={() => setNewRole(role)}
                    >
                      {roleTitle(role)}
                    </button>
                  ))}
                </div>
                <Button size="smaller" disabled={isBusy} onClick={openPicker}>{lang('ParvaneCloudShareAdd')}</Button>
              </div>
            )}
            {isOwner && (
              <div className={styles.shareHint}>
                {lang(newRole === 'editor' ? 'ParvaneCloudRoleEditorHint' : 'ParvaneCloudRoleReaderHint')}
              </div>
            )}
            <div className="dialog-buttons">
              {isOwner && (
                <Button
                  className="confirm-dialog-button"
                  isText
                  disabled={isBusy}
                  onClick={() => setConfirm('private')}
                >
                  {lang('ParvaneCloudMakePrivate')}
                </Button>
              )}
              {isOwner && (
                <Button
                  className="confirm-dialog-button"
                  isText
                  color="danger"
                  disabled={isBusy}
                  onClick={() => setConfirm('remove')}
                >
                  {lang('ParvaneCloudStopSharing')}
                </Button>
              )}
              {!isOwner && (
                <Button
                  className="confirm-dialog-button"
                  isText
                  color="danger"
                  disabled={isBusy}
                  onClick={() => setConfirm('leave')}
                >
                  {lang('ParvaneCloudLeave')}
                </Button>
              )}
              <Button className="confirm-dialog-button" isText onClick={onClose}>{lang('ParvaneCloudClose')}</Button>
            </div>
          </div>
        )}
        {!container && id && <div className={styles.dialogEmpty}>{lang('ParvaneCloudInviteGone')}</div>}
      </Modal>
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
