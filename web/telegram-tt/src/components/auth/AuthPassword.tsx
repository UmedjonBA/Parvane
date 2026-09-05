import { memo, useCallback, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { pick } from '../../util/iteratees';

import useLang from '../../hooks/useLang';

import PasswordForm from '../common/PasswordForm';
import MonkeyPassword from '../common/PasswordMonkey';
import Button from '../ui/Button';

type StateProps = {
  auth: GlobalState['auth'];
};

const AuthPassword = ({
  auth,
}: StateProps) => {
  const { setAuthPassword, clearAuthErrorKey, parvaneStartRegistration } = getActions();
  const { isLoading, errorKey, hint } = auth;

  const lang = useLang();
  const [showPassword, setShowPassword] = useState(false);

  const handleChangePasswordVisibility = useCallback((isVisible) => {
    setShowPassword(isVisible);
  }, []);

  const handleSubmit = useCallback((password: string) => {
    setAuthPassword({ password });
  }, [setAuthPassword]);

  // Parvane: на сервере с подтверждением вход не регистрирует неизвестный
  // ник — отсюда путь на форму регистрации (ник уже заполнен)
  const handleCreateAccount = useCallback(() => {
    parvaneStartRegistration();
  }, [parvaneStartRegistration]);

  return (
    <div id="auth-password-form" className="custom-scroll">
      <div className="auth-form">
        <MonkeyPassword isPasswordVisible={showPassword} />
        <h1>{lang('LoginHeaderPassword')}</h1>
        <p className="note">{lang('LoginEnterPasswordDescription')}</p>
        <PasswordForm
          onClearError={clearAuthErrorKey}
          error={errorKey && lang.withRegular(errorKey)}
          hint={hint}
          isLoading={isLoading}
          isPasswordVisible={showPassword}
          onChangePasswordVisibility={handleChangePasswordVisibility}
          onSubmit={handleSubmit}
        />
        <Button className="auth-button" isText onClick={handleCreateAccount}>
          {lang('ParvaneCreateAccount')}
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => (
    pick(global, ['auth'])
  ),
)(AuthPassword));
