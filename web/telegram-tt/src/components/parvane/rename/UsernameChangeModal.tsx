import type { ChangeEvent } from 'react';
import { memo, useEffect, useState } from '../../../lib/teact/teact';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import SecretForm from '../../ui/SecretForm';

import styles from './UsernameChangeModal.module.scss';

type OwnProps = {
  isOpen: boolean;
  currentNick?: string;
  onClose: NoneToVoidFunction;
};

type RenameResult = 'ok' | 'bad_password' | 'bad_key' | 'no_backup' | 'taken' | 'invalid' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// Как на сервере: строчные латинские буквы, цифры, `_ . -`; первый символ — буква или цифра; 2–64 символа
const NICK_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

const ERROR_KEYS = {
  bad_password: 'ParvaneRenameErrorPassword',
  bad_key: 'ParvaneRenameErrorKey',
  no_backup: 'ParvaneRenameErrorNoBackup',
  taken: 'ParvaneRenameErrorTaken',
  invalid: 'ParvaneRenameErrorInvalid',
  failed: 'ParvaneRenameErrorFailed',
} as const;

// Смена ника (spec 026): новый ник, пароль и ключ восстановления (личность подписывает смену корнем). Прежний ник
// 30 дней ведёт на новый; чаты, группы, «План» и облако остаются. После успеха вкладка перезагружается
const UsernameChangeModal = ({ isOpen, currentNick, onClose }: OwnProps) => {
  const lang = useLang();
  const [nick, setNick] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [error, setError] = useState<RenameResult | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [isDone, setIsDone] = useState(false);

  // Поля чистятся при закрытии, а не при открытии: эффект открытия стирал бы набранное в первый кадр
  useEffect(() => {
    if (isOpen) return;
    setNick('');
    setPassword('');
    setRecoveryKey('');
    setError(undefined);
    setIsDone(false);
  }, [isOpen]);

  const normalized = nick.trim().toLowerCase();
  const isNickValid = NICK_PATTERN.test(normalized) && normalized !== currentNick;
  const canSubmit = isNickValid && Boolean(password) && Boolean(recoveryKey.trim()) && !isBusy && !isDone;

  const handleNick = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNick(e.target.value.replace(/^@/, ''));
    setError(undefined);
  });
  const handlePassword = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    setError(undefined);
  });
  const handleKey = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setRecoveryKey(e.target.value);
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async () => {
    if (!canSubmit) return;
    setIsBusy(true);
    const out = await callParvane('parvaneRenameAccount', { nick: normalized, password, recoveryKey })
      .catch(() => undefined) as { result?: RenameResult } | undefined;
    setIsBusy(false);
    const result = out?.result || 'failed';
    if (result === 'ok') {
      setIsDone(true);
      return;
    }
    setError(result);
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={lang('ParvaneRenameTitle')} className={styles.root}>
      <div data-rename-dialog>
        <p className={styles.hint}>{lang('ParvaneRenameHint')}</p>
        <label className={styles.label} htmlFor="parvane-rename-nick">{lang('ParvaneRenameNick')}</label>
        <div className={styles.nickRow}>
          <span className={styles.at}>@</span>
          <input
            id="parvane-rename-nick"
            className="form-control"
            autoComplete="off"
            spellCheck={false}
            value={nick}
            placeholder={currentNick}
            onChange={handleNick}
          />
        </div>
        {nick && !isNickValid && (
          <p className={styles.note} data-rename-nick-invalid>{lang('ParvaneRenameNickRule')}</p>
        )}
        <SecretForm className={styles.secrets}>
          <label className={styles.label} htmlFor="parvane-rename-password">{lang('ParvaneRenamePassword')}</label>
          <input
            id="parvane-rename-password"
            type="password"
            className="form-control"
            autoComplete="current-password"
            value={password}
            onChange={handlePassword}
          />
          <label className={styles.label} htmlFor="parvane-rename-key">{lang('ParvaneRenameRecoveryKey')}</label>
          <input
            id="parvane-rename-key"
            className="form-control"
            autoComplete="off"
            spellCheck={false}
            value={recoveryKey}
            onChange={handleKey}
          />
        </SecretForm>
        {error && error !== 'ok' && (
          <p className={styles.error} data-rename-error={error}>{lang(ERROR_KEYS[error])}</p>
        )}
        {isDone && <p className={styles.done} data-rename-done>{lang('ParvaneRenameDone')}</p>}
        <div className={styles.buttons} data-rename-submit-wrap>
          <Button color="translucent" onClick={onClose}>{lang('Cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} isLoading={isBusy}>{lang('ParvaneRenameSubmit')}</Button>
        </div>
      </div>
    </Modal>
  );
};

export default memo(UsernameChangeModal);
