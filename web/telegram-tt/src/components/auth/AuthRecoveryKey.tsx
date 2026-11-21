import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import buildClassName from '../../util/buildClassName';
import { copyTextToClipboard } from '../../util/clipboard';
import {
  clearRegistrationSteps, getIsFirstRunDone, readRegistrationSteps,
} from '../../util/parvaneFirstRun';
import { callApi } from '../../api/gramjs';
import { printRecoveryKey, splitRecoveryKey } from './recoveryKeyPrint';

import useAppLayout from '../../hooks/useAppLayout';
import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Portal from '../ui/Portal';
import { AuthBar } from './AuthParts';

import styles from './Auth.module.scss';

type TakenKey = { recoveryKey: string; hasEscrow?: boolean };

const callParvane = callApi as unknown as (method: string) => Promise<unknown>;
const RECOVERY_KEY_EVENT = 'parvane-recovery-key';
const KEY_FILE_NAME = 'parvane-recovery-key.txt';

// Parvane (spec 041 E4): ключ восстановления отдельным экраном по доскам `XpAuth`, `RdAuth` — вместо окна. Ключ
// приходит от провайдера один раз (новая личность: регистрация, сброс) и только когда он не ушёл владельцу в
// Telegram (spec 015). Телефон (`XpAuth`): ключ в две строки, «Скопировать», «В файл», карточка «Где хранить»;
// компьютер (`RdAuth`): ключ строкой, «Скопировать», «Сохранить в файл», «Напечатать» (печатается только ключ —
// отдельным документом), где хранить — строкой. Закрывается, только когда отмечено «Я сохранил ключ»
const AuthRecoveryKey = () => {
  const { showNotification } = getActions();
  const lang = useLang();
  const { isMobile } = useAppLayout();
  const [taken, setTaken] = useState<TakenKey | undefined>();
  const [isSaved, setIsSaved] = useState(false);
  // Первый запуск устройства (доски `XpAuth`, `RdAuth`): после ключа — выбор модулей, ключ — последний шаг регистрации
  const isFirstRunDone = useDerivedState(getIsFirstRunDone);
  const [totalSteps, setTotalSteps] = useState<number | undefined>();

  useEffect(() => {
    const takeKey = async () => {
      const result = await callParvane('parvaneTakeRecoveryKey') as TakenKey | undefined;
      if (!result) return;
      setIsSaved(false);
      setTotalSteps(readRegistrationSteps());
      setTaken(result);
    };
    // Ключ мог появиться до монтирования экрана
    void takeKey();
    window.addEventListener(RECOVERY_KEY_EVENT, takeKey);
    return () => window.removeEventListener(RECOVERY_KEY_EVENT, takeKey);
  }, []);

  const handleCopy = useLastCallback(() => {
    copyTextToClipboard(taken!.recoveryKey);
    showNotification({ message: lang('ParvaneRecoveryKeyCopied') });
  });

  const handleSaveFile = useLastCallback(() => {
    const text = `${lang('ParvaneRecoveryKeyTitle')}: ${taken!.recoveryKey}\n${lang('ParvaneRecoveryKeyWhere')}\n`;
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    anchor.download = KEY_FILE_NAME;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  });

  const handlePrint = useLastCallback(() => {
    printRecoveryKey(lang('ParvaneRecoveryKeyTitle'), taken!.recoveryKey, lang('ParvaneRecoveryKeyWhereLine'));
  });

  const handleDone = useLastCallback(() => {
    clearRegistrationSteps();
    setTaken(undefined);
  });

  if (!taken) return undefined;

  const step = totalSteps ? lang('ParvaneAuthStep', { step: totalSteps, total: totalSteps }) : undefined;

  return (
    <Portal>
      <div className={buildClassName(styles.root, styles.overlay)} data-recovery-key-screen>
        <AuthBar title={lang('ParvaneRecoveryKeyTitle')} step={step} />
        <div className={styles.page}>
          <div className={buildClassName(styles.dialog, styles.dialogCode)}>
            <div className={styles.head}>
              <h1 className={buildClassName(styles.headTitle, styles.grow)}>{lang('ParvaneRecoveryKeyTitle')}</h1>
              {step && <span className={styles.step} data-recovery-key-step>{step}</span>}
            </div>
            <p className={styles.muted}>{lang('ParvaneRecoveryKeyText')}</p>
            <div className={styles.keyBox} data-recovery-key={taken.recoveryKey}>
              {isMobile
                ? splitRecoveryKey(taken.recoveryKey).map((line) => (
                  <span key={line} className={styles.keyLine}>{line}</span>
                ))
                : taken.recoveryKey}
            </div>
            <div className={styles.keyActions}>
              <button
                type="button"
                className={buildClassName(styles.button, styles.buttonQuiet, styles.grow)}
                data-recovery-key-copy
                onClick={handleCopy}
              >
                {lang('ParvaneRecoveryKeyCopy')}
              </button>
              <button
                type="button"
                className={buildClassName(styles.button, styles.buttonQuiet, styles.grow)}
                data-recovery-key-file
                onClick={handleSaveFile}
              >
                {lang(isMobile ? 'ParvaneRecoveryKeyFile' : 'ParvaneRecoveryKeyFileDesktop')}
              </button>
              {!isMobile && (
                <button
                  type="button"
                  className={buildClassName(styles.button, styles.buttonQuiet, styles.grow)}
                  data-recovery-key-print
                  onClick={handlePrint}
                >
                  {lang('ParvaneRecoveryKeyPrint')}
                </button>
              )}
            </div>
            {isMobile ? (
              <div className={styles.card}>
                <p className={styles.caps}>{lang('ParvaneRecoveryKeyWhereTitle')}</p>
                <p className={styles.small}>{lang('ParvaneRecoveryKeyWhere')}</p>
                {taken.hasEscrow && <p className={styles.small}>{lang('ParvaneRecoveryKeyAdminHint')}</p>}
              </div>
            ) : (
              <p className={styles.small}>
                {lang('ParvaneRecoveryKeyWhereLine')}
                {taken.hasEscrow && ` ${lang('ParvaneRecoveryKeyAdminHint')}`}
              </p>
            )}
            <div className={styles.spacer} />
            <label className={styles.check}>
              <input
                type="checkbox"
                className={styles.checkBox}
                checked={isSaved}
                data-recovery-key-saved
                onChange={(e) => setIsSaved(e.currentTarget.checked)}
              />
              {lang('ParvaneRecoveryKeySaved')}
            </label>
            <button
              type="button"
              className={styles.button}
              disabled={!isSaved}
              data-recovery-key-done
              onClick={handleDone}
            >
              {lang(isFirstRunDone ? 'ParvaneRecoveryKeyDone' : 'ShellRecoveryKeyNext')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default memo(AuthRecoveryKey);
