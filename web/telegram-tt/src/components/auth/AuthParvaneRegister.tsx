import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import buildClassName from '../../util/buildClassName';
import { fetchParvaneAuthContext, fetchParvaneServerInfo } from '../../api/parvane/authApi';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import Button from '../ui/Button';
import InputText from '../ui/InputText';
import { isNickOrAddress } from './AuthParvane';

type StateProps = Pick<GlobalState, 'auth'>;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 1;

// Parvane: форма регистрации — ник, почта (если сервер требует подтверждение)
// и пароль. Дальше нативный экран кода (authorizationStateWaitCode) или сразу
// логин. Сюда же попадает вход под несуществующим ником: ник уже заполнен
const AuthParvaneRegister = ({ auth }: StateProps) => {
  const { parvaneRegister, returnToAuthPhoneNumber, clearAuthErrorKey } = getActions();

  const [nick, setNick] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  // undefined — параметры сервера ещё запрашиваются; поле почты показываем
  // только когда сервер требует подтверждение
  const [isEmailRequired, setIsEmailRequired] = useState<boolean | undefined>(undefined);

  const lang = useLang();

  const { isLoading: authIsLoading, errorKey } = auth;

  useEffect(() => {
    let isCancelled = false;
    void Promise.all([
      fetchParvaneServerInfo(),
      fetchParvaneAuthContext(),
    ]).then(([serverInfo, context]) => {
      if (isCancelled) return;
      setIsEmailRequired(Boolean(serverInfo?.emailRequired));
      if (context?.nick) setNick(context.nick);
      if (context?.email) setEmail(context.email);
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  const isNickValid = isNickOrAddress(nick);
  const isEmailValid = !isEmailRequired || EMAIL_PATTERN.test(email.trim());
  const canSubmit = isEmailRequired !== undefined
    && isNickValid && isEmailValid && password.length >= MIN_PASSWORD_LENGTH;

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

  const togglePasswordVisibility = useLastCallback(() => {
    setIsPasswordVisible(!isPasswordVisible);
  });

  const handleBack = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authIsLoading || !canSubmit) {
      return;
    }
    parvaneRegister({ nick: nick.trim(), email: email.trim(), password });
  }

  const errorText = errorKey && lang.withRegular(errorKey);
  const isNickError = errorKey?.key === 'ParvaneNickInvalid' || errorKey?.key === 'ParvaneNickTaken';
  const isEmailError = errorKey?.key === 'ParvaneEmailInvalid';
  const isGeneralError = Boolean(errorText) && !isNickError && !isEmailError;

  return (
    <div id="auth-registration-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>{lang('ParvaneRegisterTitle')}</h1>
        <p className="note">
          {isEmailRequired ? lang('ParvaneRegisterTextEmail') : lang('ParvaneRegisterText')}
        </p>
        <form className="form" action="" autoComplete="off" onSubmit={handleSubmit}>
          <InputText
            id="sign-up-parvane-nick"
            label={lang('ParvaneNickname')}
            value={nick}
            error={isNickError ? errorText : undefined}
            autoComplete="username"
            autoFocus
            onChange={handleNickChange}
          />
          {isEmailRequired && (
            <InputText
              id="sign-up-parvane-email"
              label={lang('ParvaneEmail')}
              value={email}
              error={isEmailError ? errorText : undefined}
              inputMode="email"
              autoComplete="email"
              onChange={handleEmailChange}
            />
          )}
          <div
            className={buildClassName('input-group password-input', password && 'touched')}
            dir={lang.isRtl ? 'rtl' : undefined}
          >
            <input
              className="form-control"
              type={isPasswordVisible ? 'text' : 'password'}
              id="sign-up-parvane-password"
              value={password}
              autoComplete="new-password"
              maxLength={256}
              dir="auto"
              onChange={handlePasswordChange}
            />
            <label htmlFor="sign-up-parvane-password">{lang('ParvanePassword')}</label>
            <div
              className="div-button toggle-password"
              onClick={togglePasswordVisibility}
              role="button"
              tabIndex={0}
              title={lang('AriaPasswordToggle')}
              aria-label={lang('AriaPasswordToggle')}
            >
              <Icon name={isPasswordVisible ? 'eye' : 'eye-crossed'} />
            </div>
          </div>
          {isGeneralError && <p className="note">{errorText}</p>}
          {canSubmit && (
            <Button
              className="auth-button"
              type="submit"
              ripple
              isLoading={authIsLoading}
            >
              {lang('ParvaneCreateAccount')}
            </Button>
          )}
          <Button
            className="auth-button"
            isText
            onClick={handleBack}
          >
            {lang('ParvaneHaveAccount')}
          </Button>
        </form>
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
)(AuthParvaneRegister));
