import type { ChangeEvent } from 'react';
import { memo, useEffect, useState } from '../../../lib/teact/teact';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import SecretForm from '../../ui/SecretForm';

import styles from './AccountDeleteModal.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

type DeleteResult = 'ok' | 'bad_password' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

const ERROR_KEYS = {
  bad_password: 'ParvaneDeleteAccountErrorPassword',
  failed: 'ParvaneDeleteAccountErrorFailed',
} as const;

// Удаление аккаунта (spec 027): пароль и подтверждение. Аккаунт сразу выходит со всех устройств и скрыт от
// других; через 7 дней всё стирается и ник свободен. До этого вход паролем предлагает восстановить аккаунт.
// Через несколько секунд провайдер снимает сессию и показывает экран входа (ключи устройства остаются)
const AccountDeleteModal = ({ isOpen, onClose }: OwnProps) => {
  const lang = useLang();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Exclude<DeleteResult, 'ok'> | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [deletionDate, setDeletionDate] = useState<string | undefined>();

  // Поля чистятся при закрытии: эффект открытия стирал бы набранное в первый кадр
  useEffect(() => {
    if (isOpen) return;
    setPassword('');
    setError(undefined);
  }, [isOpen]);

  const canSubmit = Boolean(password) && !isBusy && !deletionDate;

  const handlePassword = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async () => {
    if (!canSubmit) return;
    setIsBusy(true);
    const out = await callParvane('parvaneDeleteAccount', { password })
      .catch(() => undefined) as { result?: DeleteResult; deletionAtMs?: number } | undefined;
    setIsBusy(false);
    const result = out?.result || 'failed';
    if (result !== 'ok') {
      setError(result);
      return;
    }
    setDeletionDate(new Intl.DateTimeFormat(lang.code, { day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(out?.deletionAtMs || Date.now())));
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={lang('ParvaneDeleteAccountTitle')} className={styles.root}>
      <div data-delete-account-dialog>
        <p className={styles.hint}>{lang('ParvaneDeleteAccountHint')}</p>
        <ul className={styles.list}>
          <li>{lang('ParvaneDeleteAccountPointData')}</li>
          <li>{lang('ParvaneDeleteAccountPointNick')}</li>
          <li>{lang('ParvaneDeleteAccountPointRestore')}</li>
          <li>{lang('ParvaneDeleteAccountPointExport')}</li>
        </ul>
        <SecretForm className={styles.secrets}>
          <label className={styles.label} htmlFor="parvane-delete-password">{lang('ParvaneRenamePassword')}</label>
          <input
            id="parvane-delete-password"
            type="password"
            className="form-control"
            autoComplete="current-password"
            value={password}
            disabled={Boolean(deletionDate)}
            onChange={handlePassword}
          />
        </SecretForm>
        {error && <p className={styles.error} data-delete-account-error={error}>{lang(ERROR_KEYS[error])}</p>}
        {deletionDate && (
          <p className={styles.done} data-delete-account-done>
            {lang('ParvaneDeleteAccountDone', { date: deletionDate })}
          </p>
        )}
        <div className={styles.buttons}>
          <Button color="translucent" onClick={onClose} disabled={Boolean(deletionDate)}>{lang('Cancel')}</Button>
          <Button color="danger" onClick={handleSubmit} disabled={!canSubmit} isLoading={isBusy}>
            {lang('ParvaneDeleteAccountSubmit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default memo(AccountDeleteModal);
