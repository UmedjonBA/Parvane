import type { ChangeEvent } from 'react';
import { memo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import InputText from '../ui/InputText';

type StateProps = Pick<GlobalState, 'auth'>;

// Parvane: вместо телефона — федеративный адрес user@server. Дальше штатный
// экран пароля (authorizationStateWaitPassword)
const AuthParvane = ({ auth }: StateProps) => {
  const { setAuthPhoneNumber, setAuthRememberMe } = getActions();

  const [address, setAddress] = useState('');

  const lang = useLang();

  const { isLoading: authIsLoading, errorKey, rememberMe } = auth;

  const canSubmit = /^[^@\s]+@[^@\s]+$/.test(address.trim());

  const handleAddressChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setAddress(e.target.value);
  });

  const handleKeepSessionChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setAuthRememberMe({ value: e.target.checked });
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authIsLoading || !canSubmit) {
      return;
    }
    setAuthPhoneNumber({ phoneNumber: address.trim() });
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
            label={lang('ParvaneAddress')}
            value={address}
            error={errorKey && lang.withRegular(errorKey)}
            inputMode="email"
            autoFocus
            onChange={handleAddressChange}
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
