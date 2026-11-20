import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { SettingsScreens } from '../../../../types';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';
import { consumePasswordFormRequest } from './profileRequests';

import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import Button from '../../../ui/Button';
import SecretForm from '../../../ui/SecretForm';
import ProfileIcon from './ProfileIcon';
import ProfileSwitchRow from './ProfileSwitchRow';

import styles from './Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
};

type TwoFactorState = { enabled: boolean; telegramLinked: boolean };

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;
const PASSWORD_MIN_LENGTH = 8;

// Parvane (spec 041 E3): «Конфиденциальность → Защита входа» по доске `PhProfileB` — подтверждение входа в Telegram,
// смена пароля, PIN хранилища. Логика прежняя: смена 2FA и пароля — только с текущим паролем (P-07), метод v2
// `set_2fa` принимает лишь свежий пароль (E6-1)
const PrivacySignIn = ({ isActive }: OwnProps) => {
  const { showNotification, openSettingsScreen } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();

  const [twoFactor, setTwoFactor] = useState<TwoFactorState | undefined>();
  const [isTwoFactorBusy, setIsTwoFactorBusy] = useState(false);
  const [twoFactorPassword, setTwoFactorPassword] = useState('');
  const [pendingTwoFactor, setPendingTwoFactor] = useState<boolean | undefined>();
  const [isPasswordFormOpen, openPasswordForm, closePasswordForm] = useFlag();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('');
  const [isPasswordBusy, setIsPasswordBusy] = useState(false);
  const [isPinEnabled, setIsPinEnabled] = useState(false);

  const canChangePassword = Boolean(oldPassword) && newPassword.length >= PASSWORD_MIN_LENGTH
    && newPassword === newPasswordRepeat;

  // Форма пароля раскрыта — только пока экран открыт: при уходе она сворачивается, по просьбе карточки аккаунта
  // («Пароль · сменить») раскрывается при входе
  useEffect(() => {
    if (!isActive) {
      closePasswordForm();
      return;
    }
    if (consumePasswordFormRequest()) openPasswordForm();
  }, [isActive, openPasswordForm, closePasswordForm]);

  useEffect(() => {
    if (!isActive) return undefined;
    let isCancelled = false;
    void (callParvane('parvaneFetchTwoFactor', undefined) as Promise<TwoFactorState | undefined>)
      .then((state) => {
        if (!isCancelled && state) setTwoFactor(state);
      })
      .catch(() => undefined);
    void (callParvane('parvaneGetStoragePin', {}) as Promise<{ enabled: boolean } | undefined>)
      .then((state) => {
        if (!isCancelled) setIsPinEnabled(Boolean(state?.enabled));
      });
    return () => {
      isCancelled = true;
    };
  }, [isActive]);

  const applyTwoFactor = useLastCallback(async (enabled: boolean, password: string) => {
    setIsTwoFactorBusy(true);
    try {
      const state = await (
        callParvane('parvaneSetTwoFactor', { enabled, password }) as Promise<TwoFactorState | undefined>
      );
      if (state) setTwoFactor(state);
      setPendingTwoFactor(undefined);
      setTwoFactorPassword('');
    } catch {
      showNotification({ message: oldLang('ParvaneTwoFactorFailed') });
    } finally {
      setIsTwoFactorBusy(false);
    }
  });

  const handleTwoFactorChange = useLastCallback((enabled: boolean) => {
    // Повторное нажатие до подтверждения возвращает выключатель — запрос пароля закрывается
    setPendingTwoFactor(enabled === Boolean(twoFactor?.enabled) ? undefined : enabled);
    setTwoFactorPassword('');
  });

  const handleConfirmTwoFactor = useLastCallback(() => {
    if (!twoFactorPassword || pendingTwoFactor === undefined) return;
    void applyTwoFactor(pendingTwoFactor, twoFactorPassword);
  });

  const handleChangePassword = useLastCallback(async () => {
    if (!canChangePassword) return;
    setIsPasswordBusy(true);
    try {
      await callParvane('parvaneChangePassword', { oldPassword, newPassword });
      setOldPassword('');
      setNewPassword('');
      setNewPasswordRepeat('');
      closePasswordForm();
      showNotification({ message: oldLang('ParvaneChangePasswordDone') });
    } catch (error) {
      // Провайдер отдаёт причину ключом словаря (пусто — причина неизвестна)
      const reasonKey = (error as Error)?.message;
      const failed = oldLang('ParvaneChangePasswordFailed');
      showNotification({ message: reasonKey ? `${failed}: ${oldLang(reasonKey)}` : failed });
    } finally {
      setIsPasswordBusy(false);
    }
  });

  const handleOpenPin = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.PasscodeEnabled });
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);

  return (
    <>
      <div className={styles.caption}>{oldLang('ParvaneTwoFactorTitle')}</div>
      <div className={styles.group}>
        <ProfileSwitchRow
          title={oldLang('ParvaneTwoFactorToggle')}
          hint={twoFactor && !twoFactor.telegramLinked
            ? oldLang('ParvaneTwoFactorNoTelegram')
            : oldLang('ParvaneTwoFactorInfo')}
          isOn={pendingTwoFactor ?? Boolean(twoFactor?.enabled)}
          isDisabled={!twoFactor || !twoFactor.telegramLinked || isTwoFactorBusy}
          onChange={handleTwoFactorChange}
          data-privacy-row="twofa"
        />
        {pendingTwoFactor !== undefined && (
          <div className={styles.formRow} data-twofa-confirm>
            <SecretForm className={styles.form}>
              <input
                type="password"
                className="form-control"
                autoComplete="current-password"
                placeholder={oldLang('ParvanePasswordConfirm')}
                aria-label={oldLang('ParvanePasswordConfirm')}
                value={twoFactorPassword}
                onChange={(e) => setTwoFactorPassword(e.currentTarget.value)}
                disabled={isTwoFactorBusy}
              />
              <Button size="smaller" disabled={!twoFactorPassword || isTwoFactorBusy} onClick={handleConfirmTwoFactor}>
                {oldLang(pendingTwoFactor ? 'ParvaneTwoFactorEnableConfirm' : 'ParvaneTwoFactorDisableConfirm')}
              </Button>
            </SecretForm>
          </div>
        )}
        <button
          type="button"
          className={rowClass}
          aria-expanded={isPasswordFormOpen}
          data-privacy-row="password"
          onClick={isPasswordFormOpen ? closePasswordForm : openPasswordForm}
        >
          <span className={styles.setTitle}>{lang('ParvanePrivacyChangePassword')}</span>
          <ProfileIcon
            name="right"
            isSmall
            className={buildClassName(styles.menuChevron, isPasswordFormOpen && styles.chevronOpen)}
          />
        </button>
        {isPasswordFormOpen && (
          <div className={styles.formRow} data-password-form>
            <SecretForm className={styles.form}>
              <input
                type="password"
                className="form-control"
                autoComplete="current-password"
                placeholder={oldLang('ParvaneChangePasswordOld')}
                aria-label={oldLang('ParvaneChangePasswordOld')}
                value={oldPassword}
                onChange={(e) => setOldPassword(e.currentTarget.value)}
                disabled={isPasswordBusy}
              />
              <input
                type="password"
                className="form-control"
                autoComplete="new-password"
                placeholder={oldLang('ParvaneChangePasswordNew')}
                aria-label={oldLang('ParvaneChangePasswordNew')}
                value={newPassword}
                onChange={(e) => setNewPassword(e.currentTarget.value)}
                disabled={isPasswordBusy}
              />
              <input
                type="password"
                className="form-control"
                autoComplete="new-password"
                placeholder={oldLang('ParvaneChangePasswordRepeat')}
                aria-label={oldLang('ParvaneChangePasswordRepeat')}
                value={newPasswordRepeat}
                onChange={(e) => setNewPasswordRepeat(e.currentTarget.value)}
                disabled={isPasswordBusy}
              />
              <Button size="smaller" disabled={!canChangePassword || isPasswordBusy} onClick={handleChangePassword}>
                {oldLang('ParvaneChangePasswordButton')}
              </Button>
            </SecretForm>
          </div>
        )}
        <button type="button" className={rowClass} data-privacy-row="pin" onClick={handleOpenPin}>
          <span className={styles.setTitle}>{oldLang('ParvaneStoragePinTitle')}</span>
          <span className={styles.menuValue} data-pin-state={isPinEnabled ? 'on' : 'off'}>
            {lang(isPinEnabled ? 'ParvanePinOn' : 'ParvanePinOff')}
          </span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
      </div>
    </>
  );
};

export default memo(PrivacySignIn);
