import type { ChangeEvent } from 'react';
import { memo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import InputText from '../ui/InputText';

type StateProps = Pick<GlobalState, 'auth'>;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Parvane: регистрация нового аккаунта — почта для кода подтверждения. Email
// уезжает в `signUp` полем firstName (других полей у штатного экшена нет),
// дальше нативный экран кода (authorizationStateWaitCode)
const AuthParvaneEmail = ({ auth }: StateProps) => {
  const { signUp } = getActions();

  const [email, setEmail] = useState('');

  const lang = useLang();

  const { isLoading: authIsLoading, errorKey } = auth;

  const canSubmit = EMAIL_PATTERN.test(email.trim());

  const handleEmailChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authIsLoading || !canSubmit) {
      return;
    }
    signUp({ firstName: email.trim(), lastName: '' });
  }

  return (
    <div id="auth-registration-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>Parvane</h1>
        <p className="note">{lang('ParvaneEmailText')}</p>
        <form className="form" action="" onSubmit={handleSubmit}>
          <InputText
            id="sign-up-parvane-email"
            label={lang('ParvaneEmail')}
            value={email}
            error={errorKey && lang.withRegular(errorKey)}
            inputMode="email"
            autoFocus
            onChange={handleEmailChange}
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
)(AuthParvaneEmail));
