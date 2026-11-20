import { memo, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { callApi } from '../../../../api/gramjs';

import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import ConfirmDialog from '../../../ui/ConfirmDialog';
import SecretForm from '../../../ui/SecretForm';

// Диалоги экрана «Устройства», которым нужен ключ восстановления либо пароль: обновление ключа подписи (T128),
// страховочная копия для администратора, ключ в Telegram (spec 015), новый ключ восстановления («Копия ключей»,
// `ZdProfileX`) и сброс защищённой личности (T130). Корень аккаунта на устройстве (RECOVER-1 п. 8) — смена ключа
// подписи, страховочная копия и новый ключ идут без ключа восстановления: окно только подтверждает
export type KeyDialogMode = 'rotate' | 'escrow' | 'telegram' | 'renew';

// `telegram` / `shown` — новый ключ восстановления создан и ушёл в Telegram либо показан окном
type KeyResult = 'ok' | 'telegram' | 'shown' | 'bad_key' | 'no_backup' | 'failed' | 'no_telegram';
type ResetResult = 'ok' | 'bad_password' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// `storedText` — текст окна, когда корень на устройстве и ключ не нужен (у `telegram` его нет: туда уходит сам ключ)
type KeyDialog = {
  method: string; text: string; storedText?: string; action: string; done: string; doneTelegram?: string;
};

const KEY_DIALOG: Record<KeyDialogMode, KeyDialog> = {
  rotate: {
    method: 'parvaneRotateSsk',
    text: 'ParvaneSskRotationText',
    storedText: 'ParvaneSskRotationTextStored',
    action: 'ParvaneSskRotationAction',
    done: 'ParvaneSskRotationDone',
  },
  escrow: {
    method: 'parvaneStoreEscrowCopy',
    text: 'ParvaneEscrowText',
    storedText: 'ParvaneEscrowTextStored',
    action: 'ParvaneEscrowAction',
    done: 'ParvaneEscrowDone',
  },
  telegram: {
    method: 'parvaneSendKeyToTelegram',
    text: 'ParvaneTgSendText',
    action: 'ParvaneTgSendAction',
    done: 'ParvaneTgSendDone',
  },
  renew: {
    method: 'parvaneRenewRecoveryKey',
    text: 'ParvaneRenewKeyText',
    storedText: 'ParvaneRenewKeyTextStored',
    action: 'ParvaneRenewKeyAction',
    done: 'ParvaneRenewKeyDone',
    doneTelegram: 'ParvaneRenewKeyDoneTelegram',
  },
};

const KEY_FAILURE_KEYS: Record<Exclude<KeyResult, 'ok' | 'telegram' | 'shown'>, string> = {
  bad_key: 'ParvaneSskRotationBadKey',
  no_backup: 'ParvaneSskRotationNoBackup',
  failed: 'ParvaneSskRotationFailed',
  no_telegram: 'ParvaneTgSendNoTelegram',
};

const RESET_RESULT_KEYS: Record<ResetResult, string> = {
  ok: 'ParvaneResetDone',
  bad_password: 'ParvaneResetBadPassword',
  failed: 'ParvaneResetFailed',
};

type KeyDialogProps = {
  mode?: KeyDialogMode;
  hasRoot?: boolean;
  onClose: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

export const DeviceKeyDialog = memo(({
  mode, hasRoot, onClose, onDone,
}: KeyDialogProps) => {
  const { showNotification } = getActions();
  const oldLang = useOldLang();
  const [recoveryKey, setRecoveryKey] = useState('');
  const dialog = KEY_DIALOG[mode || 'rotate'];
  const isKeyless = Boolean(hasRoot && dialog.storedText);

  const handleClose = useLastCallback(() => {
    setRecoveryKey('');
    onClose();
  });

  const handleConfirm = useLastCallback(async () => {
    const key = isKeyless ? '' : recoveryKey;
    handleClose();
    if (!key && !isKeyless) return;
    const result = await callParvane(dialog.method, { recoveryKey: key }) as KeyResult | undefined;
    const resultKey = result === 'telegram' ? dialog.doneTelegram || dialog.done
      : result === 'ok' || result === 'shown' ? dialog.done : KEY_FAILURE_KEYS[result || 'failed'];
    showNotification({ message: oldLang(resultKey) });
    onDone();
  });

  return (
    <ConfirmDialog
      isOpen={Boolean(mode)}
      onClose={handleClose}
      text={oldLang(isKeyless ? dialog.storedText! : dialog.text)}
      confirmLabel={oldLang(dialog.action)}
      confirmHandler={handleConfirm}
      isConfirmDisabled={!isKeyless && !recoveryKey}
      areButtonsInColumn
    >
      {!isKeyless && (
        <input
          type="text"
          className="form-control"
          autoComplete="off"
          spellCheck={false}
          placeholder={oldLang('ParvaneSskRotationPlaceholder')}
          aria-label={oldLang('ParvaneSskRotationPlaceholder')}
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.currentTarget.value)}
        />
      )}
    </ConfirmDialog>
  );
});

type ResetDialogProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

export const ResetIdentityDialog = memo(({ isOpen, onClose, onDone }: ResetDialogProps) => {
  const { showNotification } = getActions();
  const oldLang = useOldLang();
  const [password, setPassword] = useState('');

  const handleClose = useLastCallback(() => {
    setPassword('');
    onClose();
  });

  const handleConfirm = useLastCallback(async () => {
    const value = password;
    handleClose();
    if (!value) return;
    const result = await callParvane('parvaneResetIdentity', { password: value }) as ResetResult | undefined;
    showNotification({ message: oldLang(RESET_RESULT_KEYS[result || 'failed']) });
    onDone();
  });

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={handleClose}
      text={oldLang('ParvaneResetText')}
      confirmLabel={oldLang('ParvaneResetConfirm')}
      confirmHandler={handleConfirm}
      confirmIsDestructive
      isConfirmDisabled={!password}
      areButtonsInColumn
    >
      <SecretForm>
        <input
          type="password"
          className="form-control"
          autoComplete="current-password"
          placeholder={oldLang('ParvanePasswordConfirm')}
          aria-label={oldLang('ParvanePasswordConfirm')}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </SecretForm>
    </ConfirmDialog>
  );
});
