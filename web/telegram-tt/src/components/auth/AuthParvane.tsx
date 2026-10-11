import type { ChangeEvent } from 'react';
import { memo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { saveRememberMe } from '../../api/parvane/authStorage';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import InputText from '../ui/InputText';

type StateProps = Pick<GlobalState, 'auth'>;

// Ник нового аккаунта (зеркало valid_nick в identity). Полный адрес
// user@server тоже принимается — для аккаунтов с других серверов
export const NICK_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/i;
export const FULL_ADDRESS_PATTERN = /^[^@\s]+@[^@\s]+$/;

export function isNickOrAddress(value: string) {
  const trimmed = value.trim();
  return NICK_PATTERN.test(trimmed) || FULL_ADDRESS_PATTERN.test(trimmed);
}

// Parvane: вместо телефона — ник (сервер дополняет до ник@домен) или полный
// адрес user@server. Дальше штатный экран пароля
// (authorizationStateWaitPassword); «Создать аккаунт» — форма регистрации
const AuthParvane = ({ auth }: StateProps) => {
  const { setAuthPhoneNumber, setAuthRememberMe, parvaneStartRegistration } = getActions();

  const [nick, setNick] = useState('');

  const lang = useLang();

  const { isLoading: authIsLoading, errorKey, rememberMe } = auth;

  const canSubmit = isNickOrAddress(nick);

  const handleNickChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNick(e.target.value);
  });

  const handleKeepSessionChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setAuthRememberMe({ value: e.target.checked });
    // Провайдер читает этот флаг из localStorage при сохранении/восстановлении
    // сессии (глобальный кэш tt у нас выключен)
    saveRememberMe(e.target.checked);
  });

  const handleCreateAccount = useLastCallback(() => {
    if (authIsLoading) {
      return;
    }
    parvaneStartRegistration();
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authIsLoading || !canSubmit) {
      return;
    }
    setAuthPhoneNumber({ phoneNumber: nick.trim() });
  }

  return (
    <div id="auth-phone-number-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>Parvane</h1>
        <p className="note">{lang('ParvaneStartText')}</p>
        <form className="form" action="" onSubmit={handleSubmit}>
          <InputText
            id="sign-in-parvane-address"
            label={lang('ParvaneNickname')}
            value={nick}
            error={errorKey && lang.withRegular(errorKey)}
            autoComplete="username"
            autoFocus
            onChange={handleNickChange}
          />
          <Checkbox
            id="sign-in-keep-session"
            label={lang('AuthKeepSignedIn')}
            checked={Boolean(rememberMe)}
            onChange={handleKeepSessionChange}
          />
          {canSubmit && (
            <Button
              className="auth-button"
              type="submit"
              ripple
              isLoading={authIsLoading}
            >
              {lang('LoginNext')}
            </Button>
          )}
          <Button
            className="auth-button"
            isText
            onClick={handleCreateAccount}
          >
            {lang('ParvaneCreateAccount')}
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
)(AuthParvane));
