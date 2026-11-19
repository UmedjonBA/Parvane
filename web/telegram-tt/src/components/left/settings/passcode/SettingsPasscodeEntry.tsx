import { memo, useEffect, useState } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';
import { PIN_LENGTH } from '../../../../util/pinAttempts';

import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PinPad from '../../../common/PinPad';

import styles from './SettingsPasscode.module.scss';

type OwnProps = {
  step: string;
  title: string;
  error?: string;
  isBusy?: boolean;
  isActive?: boolean;
  isBackActive?: boolean;
  onComplete: (pin: string) => void;
  onClearError: NoneToVoidFunction;
  onReset: NoneToVoidFunction;
};

// Шаг ввода PIN в настройках (доска `RpProfileB`): пояснение, название шага, точки и клавиатура
const SettingsPasscodeEntry = ({
  step, title, error, isBusy, isActive, isBackActive, onComplete, onClearError, onReset,
}: OwnProps) => {
  const lang = useLang();
  const [pin, setPin] = useState('');

  useHistoryBack({ isActive: isBackActive, onBack: onReset });

  // Возврат на шаг начинает ввод заново
  useEffect(() => {
    if (isActive) setPin('');
  }, [isActive]);

  const handleChange = useLastCallback((value: string) => {
    if (value && error) onClearError();
    if (value.length < PIN_LENGTH) {
      setPin(value);
      return;
    }
    setPin('');
    onComplete(value);
  });

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.entry)} data-pin-step={step}>
      <p className={styles.about}>{lang('ParvanePinAbout')}</p>
      <div className={styles.stepTitle}>{title}</div>
      <PinPad value={pin} error={error} isActive={isActive} isDisabled={isBusy} onChange={handleChange} />
    </div>
  );
};

export default memo(SettingsPasscodeEntry);
