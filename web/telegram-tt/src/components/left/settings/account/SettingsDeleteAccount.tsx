import type { ChangeEvent } from 'react';
import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { SettingsScreens } from '../../../../types';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';

import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import SecretForm from '../../../ui/SecretForm';

import kit from '../../../parvane/notes/PvKit.module.scss';
import profile from '../profile/Profile.module.scss';
import styles from './Account.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type DeleteResult = 'ok' | 'bad_password' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

const ERROR_KEYS = {
  bad_password: 'ParvaneDeleteAccountErrorPassword',
  failed: 'ParvaneDeleteAccountErrorFailed',
} as const;

const STEP_KEYS = [
  'ParvaneDeleteStepSignOut', 'ParvaneDeleteStepWait', 'ParvaneDeleteStepErase', 'ParvaneDeleteStepMusic',
] as const;

// Parvane (spec 041, доска `XpProfile`): «Удалить аккаунт» экраном — что произойдёт, «Сначала сохранить данные»
// (выгрузка), пароль, подтверждение «Понимаю» и кнопка «Удалить аккаунт через 7 дней». Логика прежняя (spec 027):
// аккаунт сразу выходит со всех устройств, через 7 дней стирается; вход паролем до срока предлагает восстановить
const SettingsDeleteAccount = ({ isActive, onReset }: OwnProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const [password, setPassword] = useState('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [error, setError] = useState<Exclude<DeleteResult, 'ok'> | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [deletionDate, setDeletionDate] = useState<string | undefined>();

  useHistoryBack({ isActive, onBack: onReset });

  // Поля чистятся, когда экран уходит: эффект открытия стирал бы набранное в первый кадр
  useEffect(() => {
    if (isActive) return;
    setPassword('');
    setIsConfirmed(false);
    setError(undefined);
  }, [isActive]);

  const canSubmit = Boolean(password) && isConfirmed && !isBusy && !deletionDate;

  const handlePassword = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    setError(undefined);
  });

  const handleExport = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.ParvaneExport });
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
    <div
      className={buildClassName('settings-content custom-scroll', profile.screen, styles.screen)}
      data-delete-account-dialog
    >
      <div className={buildClassName(styles.box, styles.boxDanger)}>
        <p className={styles.boxTitle}>{lang('ParvaneDeleteWhatHappens')}</p>
        <ol className={styles.steps}>
          {STEP_KEYS.map((key) => <li key={key} className={styles.step}>{lang(key)}</li>)}
        </ol>
      </div>
      <div className={buildClassName(styles.box, styles.boxRow)}>
        <span className={styles.boxText}>
          <span>{lang('ParvaneDeleteSaveFirst')}</span>
          <span className={styles.muted}>{lang('ParvaneDeleteSaveFirstHint')}</span>
        </span>
        <button type="button" className={kit.btn} data-delete-account-export onClick={handleExport}>
          {lang('ParvaneDeleteExport')}
        </button>
      </div>
      <SecretForm className={styles.field}>
        <label className={styles.label} htmlFor="parvane-delete-password">{lang('ParvaneRenamePassword')}</label>
        <input
          id="parvane-delete-password"
          type="password"
          className={kit.input}
          autoComplete="current-password"
          placeholder={lang('ParvaneRenamePassword')}
          value={password}
          disabled={Boolean(deletionDate)}
          onChange={handlePassword}
        />
      </SecretForm>
      <label className={styles.check}>
        <input
          type="checkbox"
          className={styles.checkBox}
          checked={isConfirmed}
          disabled={Boolean(deletionDate)}
          data-delete-account-confirm
          onChange={(e) => setIsConfirmed(e.currentTarget.checked)}
        />
        <span>{lang('ParvaneDeleteUnderstand')}</span>
      </label>
      {error && <p className={styles.error} data-delete-account-error={error}>{lang(ERROR_KEYS[error])}</p>}
      {deletionDate && (
        <p className={styles.done} data-delete-account-done>
          {lang('ParvaneDeleteAccountDone', { date: deletionDate })}
        </p>
      )}
      <div className={styles.buttons}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnWide, styles.dangerFill)}
          disabled={!canSubmit}
          data-delete-account-submit
          onClick={handleSubmit}
        >
          {lang('ParvaneDeleteSubmitLater')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnWide)}
          disabled={Boolean(deletionDate) || isBusy}
          onClick={onReset}
        >
          {lang('Cancel')}
        </button>
      </div>
    </div>
  );
};

export default memo(SettingsDeleteAccount);
