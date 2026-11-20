import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { PIN_LENGTH } from '../../../../util/pinAttempts';
import { callApi } from '../../../../api/gramjs';

import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PinPad from '../../../common/PinPad';
import ProfileSwitchRow from '../profile/ProfileSwitchRow';

import styles from '../profile/Profile.module.scss';
import ownStyles from './SettingsPasscode.module.scss';

type OwnProps = {
  isActive?: boolean;
};

type BiometricState = { isOffered: boolean; isEnabled: boolean };
type EnableResult = 'ok' | 'bad_pin' | 'no_pin' | 'unsupported' | 'cancelled' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

const RESULT_KEYS = {
  ok: 'ParvaneBioOn',
  unsupported: 'ParvaneBioUnsupported',
  cancelled: 'ParvaneBioCancelled',
  failed: 'ParvaneBioFailed',
  no_pin: 'ParvaneBioFailed',
} as const;

// «Открывать отпечатком» (доска `RpProfileB`) под карточкой PIN: строка видна, только когда браузер может выдать
// секрет PRF аутентификатора (`storageBiometric.ts`). Включение спрашивает PIN — им открывается обёртка ключа
// хранилища, которую заворачивает секрет аутентификатора; выключение PIN не спрашивает
const SettingsPasscodeBiometric = ({ isActive }: OwnProps) => {
  const { showNotification } = getActions();
  const [state, setState] = useState<BiometricState | undefined>();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isAskingPin, startAskingPin, stopAskingPin] = useFlag();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const lang = useLang();

  const loadState = useLastCallback(async () => {
    setState(await callParvane('parvaneGetStorageBiometric') as BiometricState | undefined);
  });

  useEffect(() => {
    if (isActive) void loadState();
    else stopAskingPin();
  }, [isActive]);

  const handleToggle = useLastCallback(async () => {
    if (isBusy) return;
    if (isAskingPin) {
      stopAskingPin();
      return;
    }
    if (!state?.isEnabled) {
      setPin('');
      setError(undefined);
      startAskingPin();
      return;
    }
    markBusy();
    await callParvane('parvaneDisableStorageBiometric');
    unmarkBusy();
    showNotification({ message: lang('ParvaneBioOff') });
    await loadState();
  });

  const handlePin = useLastCallback(async (value: string) => {
    if (value && error) setError(undefined);
    if (value.length < PIN_LENGTH) {
      setPin(value);
      return;
    }
    setPin('');
    markBusy();
    const result = (await callParvane('parvaneEnableStorageBiometric', { pin: value }) || 'failed') as EnableResult;
    unmarkBusy();
    if (result === 'bad_pin') {
      setError(lang('ParvanePinWrongCurrent'));
      return;
    }
    stopAskingPin();
    showNotification({ message: lang(RESULT_KEYS[result]) });
    await loadState();
  });

  if (!state?.isOffered) return undefined;

  const title = lang('ParvaneBioUnlock');

  return (
    <>
      <div className={styles.group}>
        <ProfileSwitchRow
          title={title}
          hint={lang('ParvaneBioUnlockHint')}
          isOn={state.isEnabled || isAskingPin}
          isDisabled={isBusy}
          data-pin-biometric-toggle
          data-pin-biometric-state={state.isEnabled ? 'on' : 'off'}
          onChange={handleToggle}
        />
      </div>
      {isAskingPin && (
        <div className={ownStyles.entry} data-pin-step="biometric">
          <div className={ownStyles.stepTitle}>{lang('ParvaneBioEnterPin')}</div>
          <PinPad value={pin} error={error} isActive={isActive} isDisabled={isBusy} onChange={handlePin} />
        </div>
      )}
    </>
  );
};

export default memo(SettingsPasscodeBiometric);
