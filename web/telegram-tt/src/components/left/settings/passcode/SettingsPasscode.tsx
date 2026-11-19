import { memo, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { SettingsScreens } from '../../../../types';

import { callApi } from '../../../../api/gramjs';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import SettingsPasscodeEntry from './SettingsPasscodeEntry';
import SettingsPasscodeHub from './SettingsPasscodeHub';

export type OwnProps = {
  passcode: string;
  currentScreen: SettingsScreens;
  shownScreen: SettingsScreens;
  isActive?: boolean;
  onSetPasscode: (passcode: string) => void;
  onReset: () => void;
};

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

const NEW_PIN_SCREENS = [SettingsScreens.PasscodeNewPasscode, SettingsScreens.PasscodeNewPasscodeConfirm];
const CHANGE_PIN_SCREENS = [
  SettingsScreens.PasscodeChangePasscodeCurrent,
  SettingsScreens.PasscodeChangePasscodeNew,
  SettingsScreens.PasscodeChangePasscodeConfirm,
];
const NESTED_SCREENS = [...NEW_PIN_SCREENS, ...CHANGE_PIN_SCREENS, SettingsScreens.PasscodeTurnOff];

// Parvane (spec 041 E6): «PIN хранилища» по доскам `RpProfileB`, `ZdProfileX` — экран с выключателем и шаги
// ввода цифрами: включение (новый · повтор), смена (текущий · новый · повтор), выключение (текущий).
// Прежде здесь был код-пароль Telegram Web A, а PIN хранилища задавался двумя полями в «Конфиденциальности»
const SettingsPasscode = ({
  passcode,
  currentScreen,
  shownScreen,
  isActive,
  onSetPasscode,
  onReset,
}: OwnProps) => {
  const { openSettingsScreen, showNotification } = getActions();

  const lang = useLang();
  const oldLang = useOldLang();
  const [error, setError] = useState<string | undefined>();
  const [isBusy, setIsBusy] = useState(false);

  const clearError = useLastCallback(() => setError(undefined));

  const handleStart = useLastCallback(() => {
    onSetPasscode('');
    openSettingsScreen({ screen: SettingsScreens.PasscodeNewPasscode });
  });

  const handleNewPin = useLastCallback((pin: string) => {
    onSetPasscode(pin);
    openSettingsScreen({
      screen: currentScreen === SettingsScreens.PasscodeNewPasscode
        ? SettingsScreens.PasscodeNewPasscodeConfirm : SettingsScreens.PasscodeChangePasscodeConfirm,
    });
  });

  const applyPin = useLastCallback(async (pin: string) => {
    setIsBusy(true);
    const isDone = Boolean(await callParvane('parvaneSetStoragePin', { pin }));
    setIsBusy(false);
    onSetPasscode('');
    showNotification({ message: oldLang(isDone ? 'ParvaneStoragePinDone' : 'ParvaneStoragePinFailed') });
    openSettingsScreen({ screen: SettingsScreens.PasscodeEnabled });
  });

  const handleRepeat = useLastCallback((pin: string) => {
    if (pin !== passcode) {
      setError(lang('ParvanePinMismatch'));
      return;
    }
    void applyPin(pin);
  });

  const checkCurrent = useLastCallback(async (pin: string) => {
    setIsBusy(true);
    const isRight = Boolean(await callParvane('parvaneCheckStoragePin', { pin }));
    setIsBusy(false);
    if (!isRight) setError(lang('ParvanePinWrongCurrent'));
    return isRight;
  });

  const handleCurrentForChange = useLastCallback(async (pin: string) => {
    if (!await checkCurrent(pin)) return;
    onSetPasscode('');
    openSettingsScreen({ screen: SettingsScreens.PasscodeChangePasscodeNew });
  });

  const handleCurrentForTurnOff = useLastCallback(async (pin: string) => {
    if (await checkCurrent(pin)) void applyPin('');
  });

  function renderEntry(step: string, title: string, onComplete: (pin: string) => void, nextScreens: SettingsScreens[]) {
    return (
      <SettingsPasscodeEntry
        step={step}
        title={title}
        error={error}
        isBusy={isBusy}
        isActive={isActive}
        isBackActive={isActive || nextScreens.includes(shownScreen)}
        onComplete={onComplete}
        onClearError={clearError}
        onReset={onReset}
      />
    );
  }

  switch (currentScreen) {
    case SettingsScreens.PasscodeDisabled:
    case SettingsScreens.PasscodeEnabled:
    case SettingsScreens.PasscodeCongratulations:
      return (
        <SettingsPasscodeHub
          isActive={isActive}
          isBackActive={isActive || NESTED_SCREENS.includes(shownScreen)}
          onStart={handleStart}
          onReset={onReset}
        />
      );

    case SettingsScreens.PasscodeNewPasscode:
      return renderEntry('new', lang('ParvanePinCreate'), handleNewPin, [SettingsScreens.PasscodeNewPasscodeConfirm]);

    case SettingsScreens.PasscodeNewPasscodeConfirm:
    case SettingsScreens.PasscodeChangePasscodeConfirm:
      return renderEntry('repeat', lang('ParvanePinRepeat'), handleRepeat, []);

    case SettingsScreens.PasscodeChangePasscodeCurrent:
      return renderEntry('current', lang('ParvanePinCurrent'), handleCurrentForChange, [
        SettingsScreens.PasscodeChangePasscodeNew, SettingsScreens.PasscodeChangePasscodeConfirm,
      ]);

    case SettingsScreens.PasscodeChangePasscodeNew:
      return renderEntry('new', lang('ParvanePinNew'), handleNewPin, [SettingsScreens.PasscodeChangePasscodeConfirm]);

    case SettingsScreens.PasscodeTurnOff:
      return renderEntry('current', lang('ParvanePinCurrent'), handleCurrentForTurnOff, []);

    default:
      return undefined;
  }
};

export default memo(SettingsPasscode);
