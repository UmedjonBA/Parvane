import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ParvaneServerInfo } from '../../api/parvane/authApi';
import type { GlobalState } from '../../global/types';

import { IS_TOUCH_ENV } from '../../util/browser/windowEnvironment';
import { fetchParvaneAuthContext, fetchParvaneServerInfo } from '../../api/parvane/authApi';
import {
  checkIsEmail, checkIsNickOrAddress, countRegistrationSteps, MIN_PASSWORD_LENGTH, readFormValue,
} from './authFormat';

import useAppLayout from '../../hooks/useAppLayout';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import {
  AuthBar, AuthField, AuthLogo, AuthModeSwitch, AuthSubmit,
} from './AuthParts';

import styles from './Auth.module.scss';

type StateProps = Pick<GlobalState, 'auth'>;

type Confirm = ParvaneServerInfo['confirm'];

const NICK_ID = 'sign-up-parvane-nick';
const PASSWORD_ID = 'sign-up-parvane-password';
const EMAIL_ID = 'sign-up-parvane-email';

// Parvane: новый аккаунт, шаг 1 — ник, пароль и почта (если сервер подтверждает аккаунт письмом). Дальше экран
// кода, экран Telegram либо сразу вход. Сюда же попадает вход под несуществующим ником: ник уже заполнен
const AuthRegister = ({ auth }: StateProps) => {
  const { parvaneRegister, returnToAuthPhoneNumber, clearAuthErrorKey } = getActions();

  const [nick, setNick] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [hasTried, setHasTried] = useState(false);
  // `undefined` — параметры сервера ещё запрашиваются
  const [confirm, setConfirm] = useState<Confirm | undefined>(undefined);

  const lang = useLang();
  const { isMobile } = useAppLayout();

  const { isLoading, errorKey } = auth;
  const errorName = errorKey?.key;
  const isEmailRequired = confirm === 'email';

  useEffect(() => {
    let isCancelled = false;
    void Promise.all([
      fetchParvaneServerInfo(),
      fetchParvaneAuthContext(),
    ]).then(([serverInfo, context]) => {
      if (isCancelled) return;
      setConfirm(serverInfo?.confirm || 'none');
      if (context?.nick) setNick((current) => current || context.nick);
      if (context?.email) setEmail((current) => current || context.email);
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  const isNickValid = checkIsNickOrAddress(nick);
  const isEmailValid = !isEmailRequired || checkIsEmail(email);
  const isPasswordValid = password.length >= MIN_PASSWORD_LENGTH;

  const clearError = useLastCallback(() => {
    if (errorKey) clearAuthErrorKey();
  });

  const handleNickChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearError();
    setNick(e.target.value);
  });

  const handleEmailChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearError();
    setEmail(e.target.value);
  });

  const handlePasswordChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearError();
    setPassword(e.target.value);
  });

  const handleBack = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLoading || confirm === undefined) return;

    const form = e.currentTarget;
    const typedNick = readFormValue(form, NICK_ID).trim();
    const typedEmail = isEmailRequired ? readFormValue(form, EMAIL_ID).trim() : '';
    const typedPassword = readFormValue(form, PASSWORD_ID);
    setHasTried(true);
    if (!checkIsNickOrAddress(typedNick) || (isEmailRequired && !checkIsEmail(typedEmail))
      || typedPassword.length < MIN_PASSWORD_LENGTH) return;
    parvaneRegister({ nick: typedNick, email: typedEmail, password: typedPassword });
  });

  const errorText = errorKey && lang.withRegular(errorKey);
  const isNickError = errorName === 'ParvaneNickInvalid' || errorName === 'ParvaneNickTaken';
  const isEmailError = errorName === 'ParvaneEmailInvalid';
  const isNoAccountHint = errorName === 'ParvaneNoAccountYet';
  const isGeneralError = Boolean(errorText) && !isNickError && !isEmailError && !isNoAccountHint;

  const totalSteps = countRegistrationSteps(confirm);
  const step = lang('ParvaneAuthStep', { step: 1, total: totalSteps });
  const localNickError = hasTried && !isNickValid ? lang('ParvaneNickInvalid') : undefined;
  const nickError = isNickError ? errorText : localNickError;
  const emailError = isEmailError || (hasTried && !isEmailValid) ? lang('ParvaneEmailInvalid') : undefined;

  return (
    <div id="auth-registration-form" className={styles.root}>
      <AuthBar title={lang('ParvaneRegisterTitle')} step={step} onBack={handleBack} />
      <div className={styles.page}>
        <div className={styles.split}>
          {!isMobile && (
            <div className={styles.side}>
              <AuthLogo />
              <div>
                <h1 className={styles.name}>Parvane</h1>
                <p className={styles.muted}>{lang('ParvaneAuthTagline')}</p>
              </div>
              <p className={styles.small}>{lang('ParvaneAuthPrivacyNote')}</p>
            </div>
          )}
          <div className={styles.dialog}>
            {!isMobile && <AuthModeSwitch isRegistration onLogin={handleBack} />}
            {isNoAccountHint && <p className={styles.muted}>{errorText}</p>}
            <form className={styles.form} action="" autoComplete="off" noValidate onSubmit={handleSubmit}>
              <AuthField
                id={NICK_ID}
                label={lang('ParvaneNickname')}
                value={nick}
                hint={lang('ParvaneAuthNickHint')}
                error={nickError}
                autoComplete="username"
                maxLength={128}
                shouldAutoFocus={!IS_TOUCH_ENV}
                onChange={handleNickChange}
              />
              <AuthField
                id={PASSWORD_ID}
                type="password"
                label={lang('ParvanePassword')}
                value={password}
                hint={lang('ParvaneAuthPasswordHint')}
                error={hasTried && !isPasswordValid ? lang('ParvaneAuthPasswordHint') : undefined}
                autoComplete="new-password"
                maxLength={256}
                onChange={handlePasswordChange}
              />
              {isEmailRequired && (
                <AuthField
                  id={EMAIL_ID}
                  type="email"
                  label={lang('ParvaneEmail')}
                  value={email}
                  hint={lang('ParvaneAuthEmailHint')}
                  error={emailError}
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  onChange={handleEmailChange}
                />
              )}
              {isGeneralError && <p className={styles.error} role="alert">{errorText}</p>}
              <AuthSubmit label={lang('Next')} isLoading={isLoading} isDisabled={confirm === undefined} />
            </form>
            <div className={styles.card}>
              <p className={styles.caps}>{lang('ParvaneAuthWhatsNext')}</p>
              {confirm !== undefined && confirm !== 'none' && (
                <div className={styles.nextRow}>
                  <span className={styles.nextNumber}>2</span>
                  <span className={styles.grow}>
                    {lang(confirm === 'email' ? 'ParvaneAuthNextConfirmEmail' : 'ParvaneAuthNextConfirmTelegram')}
                  </span>
                </div>
              )}
              <div className={styles.nextRow}>
                <span className={styles.nextNumber}>{totalSteps}</span>
                <span className={styles.grow}>{lang('ParvaneAuthNextRecoveryKey')}</span>
              </div>
            </div>
            {isMobile && <span className={styles.spacer} />}
            {isMobile && (
              <button type="button" className={styles.link} data-auth-login onClick={handleBack}>
                {lang('ParvaneHaveAccount')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      auth: global.auth,
    };
  },
)(AuthRegister));
