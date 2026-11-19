import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import { PIN_LENGTH, PIN_MAX_ATTEMPTS } from '../../util/pinAttempts';
import { getPinRequest, submitPin, subscribeToPinRequest } from '../../api/parvane/pinGate';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import PinPad from '../common/PinPad';
import ConfirmDialog from '../ui/ConfirmDialog';

import styles from './LockScreen.module.scss';

export type OwnProps = {
  isLocked?: boolean;
};

const LOGO_LETTER = 'P';

// Экран «PIN при запуске» (spec 041 E6, доска `ZpSystem`): PIN хранилища — четыре цифры. Пять неверных вводов
// подряд — выход из аккаунта на этом устройстве; счётчик (`util/pinAttempts`) переживает перезагрузку страницы
const LockScreen = ({ isLocked }: OwnProps) => {
  const { signOut } = getActions();
  const lang = useLang();

  const [pin, setPin] = useState('');
  const [attemptsLeft, setAttemptsLeft] = useState(() => getPinRequest()?.attemptsLeft ?? PIN_MAX_ATTEMPTS);
  const [isWrong, markWrong, unmarkWrong] = useFlag();
  const [isChecking, markChecking, unmarkChecking] = useFlag();
  const [isSigningOut, markSigningOut] = useFlag();
  const [isForgotOpen, openForgot, closeForgot] = useFlag();
  // Цифры, набранные до следующего кадра после полного PIN, второй проверки не начинают
  const isCheckingRef = useRef(false);

  const signOutHere = useLastCallback(() => {
    if (isSigningOut) return;
    closeForgot();
    markSigningOut();
    signOut({ forceInitApi: true });
  });

  useEffect(() => {
    const update = () => {
      const request = getPinRequest();
      if (request) setAttemptsLeft(request.attemptsLeft);
    };
    update();
    return subscribeToPinRequest(update);
  }, []);

  // Попытки кончились до перезагрузки, а выйти страница не успела
  useEffect(() => {
    if (isLocked && !attemptsLeft) signOutHere();
  }, [isLocked, attemptsLeft]);

  const handleChange = useLastCallback(async (value: string) => {
    if (isCheckingRef.current) return;
    setPin(value);
    if (value.length < PIN_LENGTH) {
      if (value) unmarkWrong();
      return;
    }
    isCheckingRef.current = true;
    markChecking();
    const result = await submitPin(value);
    isCheckingRef.current = false;
    unmarkChecking();
    setPin('');
    if (result.isUnlocked) return;
    markWrong();
    setAttemptsLeft(result.attemptsLeft);
  });

  if (!isLocked) return undefined;

  const isBusy = isChecking || isSigningOut;
  const isCountShown = attemptsLeft < PIN_MAX_ATTEMPTS;
  const message = isSigningOut ? lang('ParvanePinSigningOut')
    : isWrong ? lang('ParvanePinWrong', { count: attemptsLeft })
      : isCountShown ? lang('ParvanePinAttemptsLeft', { count: attemptsLeft }) : undefined;

  return (
    <div className={styles.root} data-pin-lock data-pin-attempts-left={attemptsLeft}>
      <div className={styles.column}>
        <div className={styles.logo} aria-hidden="true">{LOGO_LETTER}</div>
        <h1 className={styles.title}>{lang('ParvanePinEnter')}</h1>
        <PinPad
          value={pin}
          error={message}
          isActive={!isForgotOpen}
          isDisabled={isBusy}
          onChange={handleChange}
        />
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.forgot}
          data-pin-forgot
          disabled={isSigningOut}
          onClick={openForgot}
        >
          {lang('ParvanePinForgot')}
        </button>
        <p className={styles.note}>{lang('ParvanePinLimitNote')}</p>
      </div>

      <ConfirmDialog
        isOpen={isForgotOpen}
        text={lang('ParvanePinForgotConfirm')}
        confirmLabel={lang('ParvanePinSignOut')}
        confirmIsDestructive
        confirmHandler={signOutHere}
        onClose={closeForgot}
      />
    </div>
  );
};

export default memo(LockScreen);
