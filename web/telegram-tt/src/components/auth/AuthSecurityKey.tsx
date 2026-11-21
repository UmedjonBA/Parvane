import type { ChangeEvent, FormEvent } from 'react';
import { memo, useLayoutEffect, useState } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';
import { callApi } from '../../api/gramjs';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Portal from '../ui/Portal';
import {
  AuthBar, AuthField, AuthNotice, AuthSubmit,
} from './AuthParts';

import styles from './Auth.module.scss';

type StepView = { isRejected: boolean; isRecoveryWrong: boolean; hasRecovery: boolean; isSupported: boolean };
type Attempt = 'ok' | 'cancelled' | 'unsupported' | 'rejected' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const STEP_EVENT = 'parvane-security-key-step';

const ATTEMPT_KEYS = {
  cancelled: 'ParvaneSecKeyLoginCancelled',
  unsupported: 'ParvaneSecKeyUnsupported',
  rejected: 'ParvaneSecKeyLoginRejected',
  failed: 'ParvaneSecKeyLoginFailed',
} as const;

// Шаг входа «вставьте ключ безопасности» (SECKEY-1): пароль верен, новое устройство подтверждает вход ключом
// USB/NFC; ключ потерян — ключом восстановления. Показывается поверх экрана пароля, пока провайдер держит шаг
const AuthSecurityKey = () => {
  const lang = useLang();
  const [step, setStep] = useState<StepView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [isRecoveryOpen, openRecovery, closeRecovery] = useFlag();
  const [recoveryKey, setRecoveryKey] = useState('');

  const loadStep = useLastCallback(async () => {
    const next = await callParvane('parvaneGetSecurityKeyStep') as StepView | undefined;
    setStep(next);
    if (!next) {
      setError(undefined);
      closeRecovery();
      setRecoveryKey('');
    }
  });

  // Шаг мог начаться до монтирования экрана
  useLayoutEffect(() => {
    void loadStep();
    window.addEventListener(STEP_EVENT, loadStep);
    return () => window.removeEventListener(STEP_EVENT, loadStep);
  }, []);

  const showAttempt = useLastCallback((result: Attempt) => {
    if (result === 'ok') return;
    setError(lang(ATTEMPT_KEYS[result]));
  });

  const handleUseKey = useLastCallback(async () => {
    if (isBusy) return;
    setError(undefined);
    markBusy();
    const result = (await callParvane('parvaneUseSecurityKey') || 'failed') as Attempt;
    unmarkBusy();
    showAttempt(result);
  });

  const handleRecoverySubmit = useLastCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (isBusy || !recoveryKey.trim()) return;
    setError(undefined);
    markBusy();
    const result = (await callParvane('parvaneUseRecoveryKeyForLogin', { recoveryKey }) || 'failed') as Attempt;
    unmarkBusy();
    if (result === 'rejected') {
      setError(lang('ParvaneSecKeyRecoveryWrong'));
      return;
    }
    showAttempt(result);
  });

  const handleRecoveryChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setRecoveryKey(e.currentTarget.value);
  });

  const handleCancel = useLastCallback(() => {
    void callParvane('parvaneCancelSecurityKey');
  });

  if (!step) return undefined;

  const title = lang('ParvaneSecKeyLoginTitle');

  return (
    <Portal>
      <div className={buildClassName(styles.root, styles.overlay)} data-security-key-step>
        <AuthBar title={title} onBack={handleCancel} />
        <div className={styles.page}>
          <div className={buildClassName(styles.dialog, styles.dialogCode)}>
            <div className={styles.head}>
              <h1 className={buildClassName(styles.headTitle, styles.grow)}>{title}</h1>
            </div>
            <p className={styles.muted}>{lang('ParvaneSecKeyLoginText')}</p>
            {!step.isSupported && (
              <AuthNotice tone="orange" title={lang('ParvaneSecKeyUnsupported')} />
            )}
            {error && <p className={styles.error} role="alert" data-security-key-error>{error}</p>}
            <button
              type="button"
              className={buildClassName(styles.button, isBusy && styles.buttonBusy)}
              disabled={isBusy || !step.isSupported}
              aria-busy={isBusy}
              data-security-key-use
              onClick={handleUseKey}
            >
              {isBusy && <span className={styles.spinner} />}
              {lang('ParvaneSecKeyLoginUse')}
            </button>
            {step.hasRecovery && !isRecoveryOpen && (
              <button type="button" className={styles.link} data-security-key-lost onClick={openRecovery}>
                {lang('ParvaneSecKeyLoginLost')}
              </button>
            )}
            {isRecoveryOpen && (
              <form className={styles.form} onSubmit={handleRecoverySubmit} data-security-key-recovery>
                <p className={styles.small}>{lang('ParvaneSecKeyRecoveryText')}</p>
                <AuthField
                  id="security-key-recovery"
                  label={lang('ParvaneSecKeyRecoveryLabel')}
                  value={recoveryKey}
                  isMono
                  shouldAutoFocus
                  autoComplete="off"
                  onChange={handleRecoveryChange}
                />
                <AuthSubmit label={lang('ParvaneSecKeyRecoverySubmit')} isLoading={isBusy} isDisabled={isBusy} />
              </form>
            )}
            <div className={styles.spacer} />
            <button
              type="button"
              className={buildClassName(styles.button, styles.buttonQuiet)}
              data-security-key-cancel
              onClick={handleCancel}
            >
              {lang('Cancel')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default memo(AuthSecurityKey);
