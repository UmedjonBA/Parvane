import type { ChangeEvent } from 'react';
import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ConfirmDialog from '../../ui/ConfirmDialog';
import SecretForm from '../../ui/SecretForm';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

type OffResult = 'ok' | 'bad_password' | 'no_key' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// Что перестаёт работать без копии ключей аккаунта на сервере
const CONSEQUENCE_KEYS = [
  'ParvaneKeysOffLossHistory', 'ParvaneKeysOffLossTelegram', 'ParvaneKeysOffLossDevices',
] as const;

// Parvane (spec 041, `ZdProfileX` «Выключить копию»): копия ключей аккаунта на сервере заменяется пометкой без ключей
// после проверки пароля аккаунта (`identity.session.reauth`); неверный пароль — окно остаётся с ошибкой
const KeysBundleOffDialog = ({ isOpen, onClose, onDone }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [password, setPassword] = useState('');
  const [isWrongPassword, setIsWrongPassword] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const handleClose = useLastCallback(() => {
    setPassword('');
    setIsWrongPassword(false);
    onClose();
  });

  const handlePassword = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.currentTarget.value);
    setIsWrongPassword(false);
  });

  const handleConfirm = useLastCallback(async () => {
    if (!password || isBusy) return;
    setIsBusy(true);
    const result = await callParvane('parvaneDisableKeyBundle', { password }) as OffResult | undefined;
    setIsBusy(false);
    if (result === 'bad_password') {
      setIsWrongPassword(true);
      return;
    }
    handleClose();
    showNotification({ message: lang(result === 'ok' ? 'ParvaneKeysOffDone' : 'ParvaneKeysOffFailed') });
    onDone();
  });

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={lang('ParvaneKeysOffTitle')}
      text={lang('ParvaneKeysOffText')}
      confirmLabel={lang('ParvaneKeysOffAction')}
      confirmHandler={handleConfirm}
      confirmIsDestructive
      isConfirmDisabled={!password || isBusy}
      areButtonsInColumn
      onClose={handleClose}
    >
      <ul className={styles.offList} data-keys-off-dialog>
        {CONSEQUENCE_KEYS.map((key) => <li key={key} className={styles.offItem}>{lang(key)}</li>)}
      </ul>
      <SecretForm>
        <input
          type="password"
          className="form-control"
          autoComplete="current-password"
          placeholder={oldLang('ParvanePasswordConfirm')}
          aria-label={oldLang('ParvanePasswordConfirm')}
          value={password}
          data-keys-off-password
          onChange={handlePassword}
        />
        {isWrongPassword && (
          <p className="error" data-keys-off-error="bad_password">{lang('ParvaneKeysOffBadPassword')}</p>
        )}
      </SecretForm>
    </ConfirmDialog>
  );
};

export default memo(KeysBundleOffDialog);
