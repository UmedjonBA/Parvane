import type { SecondFactor, SecurityKeyStep } from './securityKeys';

import {
  checkSecurityKeySupported, SecurityKeyRequiredError, signSecurityKeyStep,
} from './securityKeys';

// Шаг входа «вставьте ключ безопасности» (SECKEY-1): пароль верен, новому устройству нужен ключ. Провайдер держит
// пароль и вызов в памяти, экран входа (`AuthSecurityKey`) зовёт `signInWithKey` / `signInWithRecoveryKey` /
// `cancel`. Повтор выдачи токена идёт тем же `connectAndLogin` со вторым фактором; отказ ключа — новый вызов

export type SecurityKeyStepView = {
  isRejected: boolean;
  isRecoveryWrong: boolean;
  hasRecovery: boolean;
  isSupported: boolean;
};

export type SecurityKeyAttempt = 'ok' | 'cancelled' | 'unsupported' | 'rejected' | 'failed';

type Deps = {
  connectAndLogin: (user: string, password: string) => Promise<string>;
  setSecondFactor: (factor: SecondFactor | undefined) => void;
  completeLogin: (address: string, password: string) => Promise<void>;
  showPasswordStep: () => void;
  log: (message: string) => void;
};

type Pending = { user: string; password: string; step: SecurityKeyStep };

const STEP_EVENT = 'parvane-security-key-step';

export function createSecurityKeyLogin(deps: Deps) {
  let pending: Pending | undefined;

  function notifyStep() {
    window.dispatchEvent(new Event(STEP_EVENT));
  }

  /** Сервер попросил ключ: запомнить вход и показать шаг. */
  function startStep(user: string, password: string, step: SecurityKeyStep) {
    pending = { user, password, step };
    deps.log('вход: нужен ключ безопасности');
    deps.showPasswordStep();
    notifyStep();
  }

  function getStep(): SecurityKeyStepView | undefined {
    if (!pending) return undefined;
    return {
      isRejected: pending.step.isRejected,
      isRecoveryWrong: pending.step.isRecoveryWrong,
      hasRecovery: pending.step.hasRecovery,
      isSupported: checkSecurityKeySupported(),
    };
  }

  async function retryWith(factor: SecondFactor): Promise<SecurityKeyAttempt> {
    const current = pending!;
    deps.setSecondFactor(factor);
    try {
      const address = await deps.connectAndLogin(current.user, current.password);
      pending = undefined;
      notifyStep();
      await deps.completeLogin(address, current.password);
      return 'ok';
    } catch (err) {
      deps.setSecondFactor(undefined);
      if (err instanceof SecurityKeyRequiredError) {
        pending = { ...current, step: err.step };
        notifyStep();
        return 'rejected';
      }
      deps.log(`вход с ключом безопасности не удался: ${String(err)}`);
      return 'failed';
    }
  }

  async function signInWithKey(): Promise<SecurityKeyAttempt> {
    if (!pending) return 'failed';
    const signed = await signSecurityKeyStep(pending.step);
    if (typeof signed === 'string') return signed;
    return retryWith(signed);
  }

  async function signInWithRecoveryKey(recoveryKey: string): Promise<SecurityKeyAttempt> {
    const key = recoveryKey.trim();
    if (!pending || !key) return 'failed';
    return retryWith({ recoveryKey: key });
  }

  function cancel() {
    pending = undefined;
    notifyStep();
    deps.showPasswordStep();
  }

  return {
    startStep, getStep, signInWithKey, signInWithRecoveryKey, cancel,
  };
}
