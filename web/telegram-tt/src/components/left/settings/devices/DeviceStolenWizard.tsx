import type { ChangeEvent } from 'react';
import { memo, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import Modal from '../../../ui/Modal';
import SecretForm from '../../../ui/SecretForm';
import ChangePasswordDialog from '../profile/ChangePasswordDialog';
import { DeviceKeyDialog } from './DeviceDialogs';

import styles from './Devices.module.scss';

export type StolenTarget = {
  deviceId: string;
  // «Телефон · Android»
  title: string;
  kindTitle: string;
  seen?: string;
  // Устройство уже вышло само (ENG-04): шаг 1 — повторный отзыв своей рукой без пароля
  hasLeft?: boolean;
};

type OwnProps = {
  target?: StolenTarget;
  hasRoot?: boolean;
  onSignOutOnly: (deviceId: string) => void;
  onClose: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

type Step = 'signOut' | 'password' | 'key';
type Stage = 'intro' | 'password' | 'key';

const callParvane = callApi as unknown as (method: string, ...args: unknown[]) => Promise<unknown>;
const DEFAULT_STEPS: Record<Step, boolean> = { signOut: true, password: true, key: false };
const STEP_ROWS: {
  step: Step;
  hint: 'ParvaneStolenStepSignOutHint' | 'ParvaneStolenStepPasswordHint' | 'ParvaneStolenStepKeyHint';
  dotClass: string;
}[] = [
  { step: 'signOut', hint: 'ParvaneStolenStepSignOutHint', dotClass: styles.dotRed },
  { step: 'password', hint: 'ParvaneStolenStepPasswordHint', dotClass: styles.dotOrange },
  { step: 'key', hint: 'ParvaneStolenStepKeyHint', dotClass: styles.dotAccent },
];

// Parvane (доски `ZdProfileY` «Телефон потерян или украден» и `RpProfileC` «Устройство украдено»; Z новее —
// мастер из трёх шагов, каждый можно пропустить): 1) отзыв устройства со сменой ключей, которые оно держало
// (REVOKE-1; ключ подписи устройств меняется корнем на устройстве, без корня — ключом восстановления из поля),
// 2) окно «Сменить пароль», 3) новый ключ восстановления (`DeviceKeyDialog renew`). «Просто выйти на нём» — прежнее
// окно выхода без смены ключей. Логика — провайдер и движок, окно только связывает шаги
const DeviceStolenWizard = ({
  target, hasRoot, onSignOutOnly, onClose, onDone,
}: OwnProps) => {
  const { showNotification, loadAuthorizations } = getActions();
  const lang = useLang();
  const [steps, setSteps] = useState(DEFAULT_STEPS);
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [stage, setStage] = useState<Stage>('intro');
  const [isBusy, setIsBusy] = useState(false);
  const [isFailed, setIsFailed] = useState(false);
  // Шаги 2 и 3 идут своими окнами после закрытия этого — цель держим, пока они не закончатся
  const [pending, setPending] = useState<Step[]>([]);

  const needsPassword = steps.signOut && !target?.hasLeft;
  const canSubmit = !isBusy && (!needsPassword || Boolean(password));

  const reset = useLastCallback(() => {
    setSteps(DEFAULT_STEPS);
    setPassword('');
    setRecoveryKey('');
    setIsBusy(false);
    setIsFailed(false);
  });

  const handleClose = useLastCallback(() => {
    reset();
    setStage('intro');
    onClose();
  });

  const handleToggle = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const step = e.currentTarget.dataset.stolenStep as Step;
    const { checked } = e.currentTarget;
    setSteps((current) => ({ ...current, [step]: checked }));
  });

  const goNext = useLastCallback((rest: Step[]) => {
    const [next, ...later] = rest;
    setPending(later);
    if (next === 'password' || next === 'key') {
      setStage(next);
      return;
    }
    setStage('intro');
    onClose();
    onDone();
  });

  const signOutDevice = useLastCallback(async () => {
    const { deviceId, hasLeft } = target!;
    const isDone = hasLeft
      ? await callParvane('parvaneReportDeviceStolen', { deviceId })
      : await callParvane('terminateAuthorization', deviceId, password, true);
    if (!isDone) return false;
    loadAuthorizations();
    // Ключ подписи устройств без корня на устройстве меняется ключом восстановления — если его ввели
    const key = recoveryKey.trim();
    const ssk = await callParvane('parvaneGetSskState') as { isRotationNeeded?: boolean } | undefined;
    if (key && ssk?.isRotationNeeded) await callParvane('parvaneRotateSsk', { recoveryKey: key });
    return true;
  });

  const handleSubmit = useLastCallback(async () => {
    if (!canSubmit) return;
    const rest = (['password', 'key'] as const).filter((step) => steps[step]);
    if (steps.signOut) {
      setIsBusy(true);
      const isDone = await signOutDevice();
      setIsBusy(false);
      if (!isDone) {
        setIsFailed(true);
        return;
      }
      showNotification({ message: lang('ParvaneStolenSignedOut', { name: target!.title }) });
    }
    reset();
    goNext([...rest]);
  });

  const handleSignOutOnly = useLastCallback(() => {
    const deviceId = target!.deviceId;
    handleClose();
    onSignOutOnly(deviceId);
  });

  const handleStepClosed = useLastCallback(() => {
    goNext(pending);
  });

  function renderStepTitle(step: Step) {
    if (step === 'password') return lang('ParvaneStolenStepPassword');
    if (step === 'key') return lang('ParvaneStolenStepKey');
    const name = target!.title;
    return target!.hasLeft ? lang('ParvaneStolenStepMark', { name }) : lang('ParvaneStolenStepSignOut', { name });
  }

  const isIntroOpen = Boolean(target) && stage === 'intro';
  const submitKey = steps.signOut ? 'ParvaneStolenSubmit' : 'ParvaneStolenContinue';

  return (
    <>
      <Modal
        isOpen={isIntroOpen}
        title={target ? lang('ParvaneStolenTitle', { kind: target.kindTitle }) : undefined}
        className={styles.stolenModal}
        onClose={handleClose}
      >
        {target && (
          <div className={styles.stolen} data-stolen-wizard={target.deviceId}>
            <p className={styles.cardText}>{lang('ParvaneStolenLead')}</p>
            <div className={styles.stolenDevice}>
              <span className={styles.deviceName}>{target.title}</span>
              {target.seen && <span className={styles.deviceHint}>{target.seen}</span>}
            </div>
            <div className={styles.stolenSteps}>
              {STEP_ROWS.map(({ step, hint, dotClass }) => (
                <label key={step} className={styles.stolenStep}>
                  <span className={buildClassName(styles.stolenDot, dotClass)} />
                  <span className={styles.deviceText}>
                    <span className={styles.stolenStepTitle}>{renderStepTitle(step)}</span>
                    <span className={styles.stolenStepHint}>
                      {step === 'signOut' && target.hasLeft ? lang('ParvaneStolenStepMarkHint') : lang(hint)}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    className={styles.stolenCheck}
                    checked={steps[step]}
                    data-stolen-step={step}
                    onChange={handleToggle}
                  />
                </label>
              ))}
            </div>
            <SecretForm className={styles.stolenForm}>
              {needsPassword && (
                <label className={styles.stolenField}>
                  <span className={styles.stolenFieldLabel}>{lang('ParvaneStolenPassword')}</span>
                  <input
                    type="password"
                    className={styles.keyInput}
                    autoComplete="current-password"
                    placeholder={lang('ParvanePassword')}
                    value={password}
                    data-stolen-password
                    onChange={(e) => {
                      setPassword(e.currentTarget.value);
                      setIsFailed(false);
                    }}
                  />
                </label>
              )}
              {steps.signOut && !hasRoot && (
                <label className={styles.stolenField}>
                  <span className={styles.stolenFieldLabel}>{lang('ParvaneStolenRecoveryKey')}</span>
                  <input
                    type="text"
                    className={styles.keyInput}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    value={recoveryKey}
                    data-stolen-recovery-key
                    onChange={(e) => setRecoveryKey(e.currentTarget.value)}
                  />
                </label>
              )}
            </SecretForm>
            {isFailed && <p className={styles.error} role="alert" data-stolen-error>{lang('ParvaneStolenFailed')}</p>}
            <p className={styles.cardText}>{lang('ParvaneStolenNote')}</p>
            <div className={styles.stolenButtons}>
              {!target.hasLeft && (
                <button
                  type="button"
                  className={buildClassName(styles.linkInline, styles.stolenSignOutOnly)}
                  data-stolen-sign-out-only
                  onClick={handleSignOutOnly}
                >
                  {lang('ParvaneStolenJustSignOut')}
                </button>
              )}
              <button type="button" className={styles.button} onClick={handleClose}>{lang('Cancel')}</button>
              <button
                type="button"
                className={buildClassName(styles.button, styles.buttonRed)}
                disabled={!canSubmit}
                data-stolen-submit
                onClick={handleSubmit}
              >
                {lang(submitKey)}
              </button>
            </div>
          </div>
        )}
      </Modal>
      <ChangePasswordDialog isOpen={stage === 'password'} onClose={handleStepClosed} />
      <DeviceKeyDialog
        mode={stage === 'key' ? 'renew' : undefined}
        hasRoot={hasRoot}
        onClose={handleStepClosed}
        onDone={onDone}
      />
    </>
  );
};

export default memo(DeviceStolenWizard);
