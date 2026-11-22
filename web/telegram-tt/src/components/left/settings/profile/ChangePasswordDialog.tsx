import type { ChangeEvent } from 'react';
import { memo, useMemo, useState } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ApiSession } from '../../../../api/types';
import type { PasswordStrength } from './passwordStrength';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';
import { measurePassword } from './passwordStrength';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import ConfirmDialog from '../../../ui/ConfirmDialog';
import SecretForm from '../../../ui/SecretForm';
import ProfileSwitchRow from './ProfileSwitchRow';

import styles from './Profile.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

type StateProps = {
  // Свои устройства: названия других — подпись выключателя «Выйти на остальных устройствах»
  sessions: Record<string, ApiSession>;
};

type Field = 'old' | 'new' | 'repeat';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const STRENGTH_KEYS = {
  short: 'ParvanePasswordShort',
  fair: 'ParvanePasswordFair',
  strong: 'ParvanePasswordStrong',
} as const;

// Parvane (доски `ZdProfileX`, `RpProfileB`): окно «Сменить пароль» поверх «Устройств и аккаунта» либо
// «Конфиденциальности» — подписи над полями, оценка надёжности, «Пароли не совпадают» у поля повтора и выключатель
// «Выйти на остальных устройствах». Сервер после смены и так гасит токены других устройств (ID-06): им придётся
// войти с новым паролем; выключатель вдобавок отключает их совсем (отзыв из журнала устройств, как «Завершить все
// другие сеансы»)
const ChangePasswordDialog = ({ isOpen, sessions, onClose }: OwnProps & StateProps) => {
  const { showNotification, loadAuthorizations } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [values, setValues] = useState<Record<Field, string>>({ old: '', new: '', repeat: '' });
  const [shouldSignOutOthers, setShouldSignOutOthers] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>();

  const otherDevices = useMemo(() => Object.values(sessions).filter((session) => !session.isCurrent)
    .map((session) => session.deviceModel || session.appName), [sessions]);
  const strength = values.new ? measurePassword(values.new) : undefined;
  const isMismatch = Boolean(values.repeat) && values.repeat !== values.new;
  const canSubmit = Boolean(values.old) && strength !== undefined && strength.level !== 'short'
    && values.repeat === values.new && !isBusy;

  const handleClose = useLastCallback(() => {
    setValues({ old: '', new: '', repeat: '' });
    setError(undefined);
    setShouldSignOutOthers(false);
    onClose();
  });

  const handleInput = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const field = e.currentTarget.dataset.passwordField as Field;
    const { value } = e.currentTarget;
    setValues((current) => ({ ...current, [field]: value }));
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async () => {
    if (!canSubmit) return;
    setIsBusy(true);
    try {
      await callParvane('parvaneChangePassword', { oldPassword: values.old, newPassword: values.new });
    } catch (err) {
      // Провайдер отдаёт причину ключом словаря (пусто — причина неизвестна)
      const reasonKey = (err as Error)?.message;
      setError(reasonKey ? oldLang(reasonKey) : oldLang('ParvaneChangePasswordFailed'));
      setIsBusy(false);
      return;
    }
    // Карточка аккаунта перечитывает «менялся …»
    window.dispatchEvent(new Event('parvane-password-changed'));
    if (shouldSignOutOthers && otherDevices.length) {
      const isDone = await callParvane('terminateAllAuthorizations', values.new);
      if (!isDone) showNotification({ message: lang('ParvanePasswordOthersFailed') });
      loadAuthorizations();
    }
    setIsBusy(false);
    handleClose();
    showNotification({ message: oldLang('ParvaneChangePasswordDone') });
  });

  function describeStrength(measured: PasswordStrength) {
    const traits: string[] = [];
    if (measured.hasDigits) traits.push(lang('ParvanePasswordHasDigits'));
    if (measured.hasSymbols) traits.push(lang('ParvanePasswordHasSymbols'));
    const verdict = lang(STRENGTH_KEYS[measured.level], { count: measured.length }, { pluralValue: measured.length });
    return traits.length ? `${verdict}, ${lang.conjunction(traits)}` : verdict;
  }

  function renderField(field: Field, labelKey: Parameters<typeof lang>[0], autoComplete: string) {
    return (
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{lang(labelKey)}</span>
        <input
          type="password"
          className={buildClassName(styles.fieldInput, field === 'repeat' && isMismatch && styles.fieldInputError)}
          autoComplete={autoComplete}
          value={values[field]}
          disabled={isBusy}
          aria-invalid={field === 'repeat' && isMismatch ? true : undefined}
          data-password-field={field}
          onChange={handleInput}
        />
      </label>
    );
  }

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={lang('ParvanePrivacyChangePassword')}
      confirmLabel={oldLang('ParvaneChangePasswordButton')}
      confirmHandler={handleSubmit}
      isConfirmDisabled={!canSubmit}
      onClose={handleClose}
    >
      <SecretForm className={styles.fieldForm}>
        <div data-password-form>
          {renderField('old', 'ParvanePasswordCurrent', 'current-password')}
          {renderField('new', 'ParvanePasswordNew', 'new-password')}
          <div className={styles.fieldHint} data-password-strength={strength?.level}>
            {strength ? describeStrength(strength) : lang('ParvanePasswordRule')}
          </div>
          {renderField('repeat', 'ParvanePasswordRepeat', 'new-password')}
          {isMismatch && (
            <div className={styles.fieldError} data-password-error="mismatch">{lang('ParvanePasswordMismatch')}</div>
          )}
          {error && <div className={styles.fieldError} data-password-error="server">{error}</div>}
        </div>
      </SecretForm>
      {otherDevices.length > 0 && (
        <div className={styles.dialogGroup}>
          <ProfileSwitchRow
            title={lang('ParvanePasswordSignOutOthers')}
            hint={lang.conjunction(otherDevices)}
            isOn={shouldSignOutOthers}
            onChange={setShouldSignOutOthers}
            data-password-sign-out-others
          />
        </div>
      )}
      <div className={styles.fieldHint}>{lang('ParvanePasswordKeysHint')}</div>
    </ConfirmDialog>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return { sessions: global.activeSessions.byHash };
  },
)(ChangePasswordDialog));
