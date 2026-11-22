import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TOUCH_ENV } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import { fetchParvaneAuthContext } from '../../api/parvane/authApi';
import { readLoginAddress, saveRememberMe } from '../../api/parvane/authStorage';
import {
  checkIsNickOrAddress, getAuthServer, getNickOfAddress, readFormValue,
} from './authFormat';

import useAppLayout from '../../hooks/useAppLayout';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import AuthDeletionPending from './AuthDeletionPending';
import {
  AuthField, AuthLogo, AuthModeSwitch, AuthNotice, AuthSubmit,
} from './AuthParts';
import AuthPrefs from './AuthPrefs';

import styles from './Auth.module.scss';

type OwnProps = {
  // Провайдер уже знает ник и ждёт пароль (`authorizationStateWaitPassword`)
  isPasswordStep?: boolean;
};

type StateProps = Pick<GlobalState, 'auth'>;

const NICK_ID = 'sign-in-parvane-address';
const PASSWORD_ID = 'sign-in-password';
// Ошибки-плашки не сбрасываются набором пароля: они не про введённое
const NOTICE_ERRORS = new Set(['ParvaneUpgradeRequired', 'ParvaneAccountDeletionPending']);

// Parvane: вход одной формой — сервер, ник, пароль. Провайдер принимает их по очереди (ник → пароль), экран
// проводит оба шага сам; Enter в поле ника без пароля переводит к паролю. Сюда же возвращает истёкший сеанс:
// ник уже известен, остаётся ввести пароль
const AuthLogin = ({ isPasswordStep, auth }: OwnProps & StateProps) => {
  const {
    setAuthPhoneNumber, setAuthPassword, setAuthRememberMe, returnToAuthPhoneNumber, clearAuthErrorKey,
    parvaneStartRegistration,
  } = getActions();

  const nickRef = useRef<HTMLInputElement>();
  const passwordRef = useRef<HTMLInputElement>();
  // Пароль, набранный вместе с ником: уходит провайдеру, как только тот примет ник
  const pendingPasswordRef = useRef<string>();

  const [nick, setNick] = useState('');
  const [password, setPassword] = useState('');
  const [isNickRejected, setIsNickRejected] = useState(false);

  const lang = useLang();
  const { isMobile } = useAppLayout();

  const { isLoading, errorKey, rememberMe } = auth;
  const errorName = errorKey?.key;

  useEffect(() => {
    if (!isPasswordStep) return undefined;

    const pending = pendingPasswordRef.current;
    pendingPasswordRef.current = undefined;
    if (pending) {
      setAuthPassword({ password: pending });
      return undefined;
    }
    if (pending !== undefined || !IS_TOUCH_ENV) passwordRef.current!.focus();

    // Истёкший сеанс и возврат с других экранов: ник помнит провайдер либо хранилище устройства
    let isCancelled = false;
    void fetchParvaneAuthContext().then((context) => {
      if (isCancelled) return;
      const known = context?.nick || getNickOfAddress(readLoginAddress() || '');
      setNick((current) => current || known);
    });
    return () => {
      isCancelled = true;
    };
  }, [isPasswordStep]);

  useEffect(() => {
    if (errorName) pendingPasswordRef.current = undefined;
  }, [errorName]);

  const handleNickChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNick(e.target.value);
    setIsNickRejected(false);
    // Ник изменён после того, как провайдер его принял, — начинаем с шага ника
    if (isPasswordStep) {
      returnToAuthPhoneNumber();
    } else if (errorKey) {
      clearAuthErrorKey();
    }
  });

  const handlePasswordChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (errorName && !NOTICE_ERRORS.has(errorName)) clearAuthErrorKey();
  });

  const handleKeepSessionChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setAuthRememberMe({ value: e.target.checked });
    // Провайдер читает этот флаг из хранилища устройства при сохранении и восстановлении сессии
    saveRememberMe(e.target.checked);
  });

  const handleRegister = useLastCallback(() => {
    if (!isLoading) parvaneStartRegistration();
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLoading) return;

    const trimmed = readFormValue(e.currentTarget, NICK_ID).trim();
    const typedPassword = readFormValue(e.currentTarget, PASSWORD_ID);
    if (!checkIsNickOrAddress(trimmed)) {
      setIsNickRejected(true);
      nickRef.current!.focus();
      return;
    }
    if (!isPasswordStep) {
      pendingPasswordRef.current = typedPassword;
      setAuthPhoneNumber({ phoneNumber: trimmed });
      return;
    }
    if (!typedPassword) {
      passwordRef.current!.focus();
      return;
    }
    setAuthPassword({ password: typedPassword });
  });

  const errorText = errorKey && lang.withRegular(errorKey);
  const isNickError = isNickRejected || errorName === 'ParvaneNickInvalid';
  const isUpgradeRequired = errorName === 'ParvaneUpgradeRequired';
  // spec 027: аккаунт ждёт удаления — пароль верен, вход только с отменой удаления
  const isDeletionPending = errorName === 'ParvaneAccountDeletionPending';
  const isPasswordError = Boolean(errorText) && !isNickError && !isUpgradeRequired && !isDeletionPending;

  const privacy = (
    <p className={buildClassName(isMobile ? styles.note : styles.small, styles.noteCenter)}>
      {lang('ParvaneAuthPrivacyNote')}
    </p>
  );

  return (
    <div id={isPasswordStep ? 'auth-password-form' : 'auth-phone-number-form'} className={styles.root}>
      <div className={buildClassName(styles.page, styles.pageStart)}>
        <div className={styles.split}>
          {/* Телефон, аккаунт ждёт удаления (доска `RpProfileC`): экран без шапки входа */}
          <div className={buildClassName(styles.side, isMobile && isDeletionPending && styles.hidden)}>
            <AuthLogo />
            <div>
              <h1 className={styles.name}>Parvane</h1>
              <p className={styles.muted}>{lang(isMobile ? 'ParvaneStartText' : 'ParvaneAuthTagline')}</p>
            </div>
            {!isMobile && privacy}
            {!isMobile && <AuthPrefs />}
          </div>
          <div className={styles.dialog}>
            {!isMobile && !isDeletionPending && <AuthModeSwitch onRegister={handleRegister} />}
            {isDeletionPending && (
              <AuthDeletionPending />
            )}
            <form
              className={buildClassName(styles.form, isDeletionPending && styles.hidden)}
              action=""
              noValidate
              onSubmit={handleSubmit}
            >
              <AuthField
                id="sign-in-parvane-server"
                label={lang('ParvaneAuthServer')}
                value={getAuthServer()}
                isMono
                isReadOnly
              />
              <AuthField
                id={NICK_ID}
                inputRef={nickRef}
                label={lang('ParvaneNickname')}
                value={nick}
                placeholder={lang('ParvaneAuthNickPlaceholder')}
                error={isNickError ? lang('ParvaneNickInvalid') : undefined}
                autoComplete="username"
                maxLength={128}
                shouldAutoFocus={!isPasswordStep && !IS_TOUCH_ENV}
                onChange={handleNickChange}
              />
              <AuthField
                id={PASSWORD_ID}
                inputRef={passwordRef}
                type="password"
                label={lang('ParvanePassword')}
                value={password}
                placeholder={lang('ParvanePassword')}
                error={isPasswordError ? errorText : undefined}
                autoComplete="current-password"
                maxLength={256}
                onChange={handlePasswordChange}
              />
              <label className={styles.check}>
                <input
                  id="sign-in-keep-session"
                  className={styles.checkBox}
                  type="checkbox"
                  checked={Boolean(rememberMe)}
                  onChange={handleKeepSessionChange}
                />
                {lang('AuthKeepSignedIn')}
              </label>
              <AuthSubmit label={lang('ParvaneAuthLogIn')} isLoading={isLoading} />
            </form>
            {isUpgradeRequired && (
              <AuthNotice tone="orange" title={lang('ParvaneAuthUpgradeTitle')} text={lang('ParvaneAuthUpgradeText')}>
                <button type="button" className={styles.chip} data-auth-update onClick={reloadApp}>
                  {lang('ParvaneAuthUpgradeAction')}
                </button>
              </AuthNotice>
            )}
            {isMobile && !isDeletionPending && (
              <button type="button" className={styles.link} data-auth-register onClick={handleRegister}>
                {lang('ParvaneRegisterTitle')}
              </button>
            )}
            {isMobile && <span className={styles.spacer} />}
            {isMobile && privacy}
            {isMobile && <AuthPrefs />}
          </div>
        </div>
      </div>
    </div>
  );
};

function reloadApp() {
  window.location.reload();
}

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      auth: global.auth,
    };
  },
)(AuthLogin));
