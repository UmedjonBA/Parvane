import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TOUCH_ENV } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import { fetchParvaneAuthContext } from '../../api/parvane/authApi';

import useFlag from '../../hooks/useFlag';
import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import { AuthBar, AuthSubmit } from './AuthParts';

import styles from './Auth.module.scss';

type StateProps = Pick<GlobalState, 'auth'>;

// Parvane: 6-значный код подтверждения почты (`identity.email.confirm`)
const CODE_LENGTH = 6;
const CODE_CELLS = Array.from({ length: CODE_LENGTH }, (_, index) => index);
const STEP = 2;
const TOTAL_STEPS = 3;

// Новый аккаунт, шаг 2: код из письма. Клетки показывают набранное, само поле одно и лежит поверх них
const AuthCode = ({ auth }: StateProps) => {
  const { setAuthCode, returnToAuthPhoneNumber, clearAuthErrorKey } = getActions();

  const inputRef = useRef<HTMLInputElement>();

  const [code, setCode] = useState('');
  // Почта, на которую ушёл код: адрес аккаунта пользователю здесь ничего не говорит
  const [email, setEmail] = useState('');
  const [isFocused, markFocused, unmarkFocused] = useFlag();

  const lang = useLang();

  const { isLoading, errorKey } = auth;

  useEffect(() => {
    let isCancelled = false;
    void fetchParvaneAuthContext().then((context) => {
      if (!isCancelled && context) setEmail(context.email || context.nick);
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!IS_TOUCH_ENV) inputRef.current!.focus();
  }, []);

  const handleBack = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  useHistoryBack({
    isActive: true,
    onBack: handleBack,
  });

  const handleChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (errorKey) clearAuthErrorKey();

    const value = e.target.value.replace(/\D+/g, '').slice(0, CODE_LENGTH);
    if (value === code) return;

    setCode(value);
    if (value.length === CODE_LENGTH) setAuthCode({ code: value });
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLoading || code.length !== CODE_LENGTH) return;
    setAuthCode({ code });
  });

  const errorText = errorKey && lang.withRegular(errorKey);
  const step = lang('ParvaneAuthStep', { step: STEP, total: TOTAL_STEPS });
  const activeCell = Math.min(code.length, CODE_LENGTH - 1);

  return (
    <div id="auth-code-form" className={styles.root}>
      <AuthBar title={lang('ParvaneAuthConfirmTitle')} step={step} onBack={handleBack} />
      <div className={styles.page}>
        <form
          className={buildClassName(styles.dialog, styles.dialogCode)}
          action=""
          noValidate
          onSubmit={handleSubmit}
        >
          <div className={styles.head}>
            <h1 className={buildClassName(styles.headTitle, styles.grow)}>{lang('ParvaneAuthConfirmTitle')}</h1>
            <span className={styles.step}>{step}</span>
          </div>
          <p className={styles.muted}>
            {lang('ParvaneAuthCodeSentTo', {
              email: <span className={styles.strong} data-auth-email>{email}</span>,
            }, { withNodes: true })}
          </p>
          <div className={styles.code}>
            {CODE_CELLS.map((index) => (
              <span
                key={index}
                className={buildClassName(
                  styles.codeCell,
                  isFocused && index === activeCell && styles.codeCellOn,
                  errorText && styles.codeCellError,
                )}
                aria-hidden="true"
              >
                {code[index]}
              </span>
            ))}
            <input
              ref={inputRef}
              id="sign-in-code"
              className={styles.codeInput}
              type="text"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              aria-label={lang('ParvaneAuthCodeGroup')}
              aria-invalid={Boolean(errorText)}
              onChange={handleChange}
              onFocus={markFocused}
              onBlur={unmarkFocused}
            />
          </div>
          {errorText && <p className={styles.error} role="alert">{errorText}</p>}
          <p className={styles.small}>{lang('ParvaneAuthCodeResendHint')}</p>
          <div className={buildClassName(styles.actions, styles.onlyDesk)}>
            <button
              type="button"
              className={buildClassName(styles.button, styles.buttonQuiet, styles.actionsButton)}
              data-auth-back="dialog"
              onClick={handleBack}
            >
              {lang('Back')}
            </button>
            <AuthSubmit
              label={lang('Next')}
              className={styles.actionsButton}
              isLoading={isLoading}
              isDisabled={code.length !== CODE_LENGTH}
            />
          </div>
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
)(AuthCode));
