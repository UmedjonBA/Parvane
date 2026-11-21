import { memo, useEffect, useMemo, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { ProfileChoice } from '../profile/ProfileChoiceSheet';
import { SettingsScreens } from '../../../../types';

import {
  AUTO_LOCK_CHOICES, getAutoLockMinutes, lockAppNow, setAutoLockMinutes,
} from '../../../../util/autoLock';
import { IS_MAC_OS } from '../../../../util/browser/windowEnvironment';
import buildClassName from '../../../../util/buildClassName';
import { getNotifyPrefs, updateNotifyPrefs } from '../../../../util/notifyPrefs';
import { callApi } from '../../../../api/gramjs';

import useDerivedState from '../../../../hooks/useDerivedState';
import useFlag from '../../../../hooks/useFlag';
import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import PvSwitch from '../../../parvane/notes/PvSwitch';
import Loading from '../../../ui/Loading';
import ProfileChoiceSheet from '../profile/ProfileChoiceSheet';
import ProfileIcon from '../profile/ProfileIcon';
import ProfileSwitchRow from '../profile/ProfileSwitchRow';
import SettingsPasscodeBiometric from './SettingsPasscodeBiometric';
import SettingsSecurityKeys from './SettingsSecurityKeys';

import styles from '../profile/Profile.module.scss';
import ownStyles from './SettingsPasscode.module.scss';

type OwnProps = {
  isActive?: boolean;
  isBackActive?: boolean;
  onStart: NoneToVoidFunction;
  onReset: NoneToVoidFunction;
};

type MigrationState = { active: boolean; errors: string[] };

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;
// spec 035 T044: после установки PIN ключ хранилища меняется фоном; дольше — показываем ход
const MIGRATION_SHOWN_AFTER_MS = 2000;
const MIGRATION_POLL_MS = 500;

// «PIN хранилища» (доска `ZdProfileX`, карточка «PIN при запуске»): выключатель, «Блокировать сейчас», смена
const SettingsPasscodeHub = ({
  isActive, isBackActive, onStart, onReset,
}: OwnProps) => {
  const { openSettingsScreen, showNotification } = getActions();
  const lang = useLang();
  const notifyPrefs = useDerivedState(getNotifyPrefs);
  const oldLang = useOldLang();

  const [isEnabled, setIsEnabled] = useState<boolean | undefined>();
  const [isMigrating, setIsMigrating] = useState(false);

  useHistoryBack({ isActive: isBackActive, onBack: onReset });

  useEffect(() => {
    if (!isActive) return;
    void (callParvane('parvaneGetStoragePin', {}) as Promise<{ enabled: boolean } | undefined>)
      .then((state) => setIsEnabled(Boolean(state?.enabled)));
  }, [isActive]);

  useEffect(() => {
    if (!isActive || !isEnabled) return undefined;
    const startedAt = Date.now();
    let timer: number | undefined;
    let isStopped = false;
    let wasRunning = false;
    const poll = async () => {
      const state = await callParvane('parvaneGetStorageMigration', {}) as MigrationState | undefined;
      if (isStopped) return;
      if (state?.active) {
        wasRunning = true;
        if (Date.now() - startedAt > MIGRATION_SHOWN_AFTER_MS) setIsMigrating(true);
        timer = window.setTimeout(poll, MIGRATION_POLL_MS);
        return;
      }
      setIsMigrating(false);
      if (wasRunning && state?.errors.length) {
        showNotification({ message: oldLang('ParvaneStorageMigrationFailed', [state.errors[0]]) });
      }
    };
    void poll();
    return () => {
      isStopped = true;
      window.clearTimeout(timer);
    };
  }, [isActive, isEnabled, oldLang]);

  const handleToggle = useLastCallback(() => {
    if (isEnabled) {
      openSettingsScreen({ screen: SettingsScreens.PasscodeTurnOff });
      return;
    }
    onStart();
  });

  const autoLockMinutes = useDerivedState(getAutoLockMinutes);
  const autoLockItems = useMemo<ProfileChoice[]>(() => AUTO_LOCK_CHOICES.map((minutes) => ({
    value: String(minutes),
    label: minutes
      ? lang('ParvanePinAutoLockMinutes', { count: minutes }, { pluralValue: minutes })
      : lang('ParvanePinAutoLockOff'),
  })), [lang]);

  const handleAutoLockChange = useLastCallback((value: string) => {
    setAutoLockMinutes(Number(value));
  });

  // «Блокировать · через 5 минут без действий ▾» (доска `ZdProfileX`): строка со шторкой выбора
  const [isAutoLockOpen, openAutoLock, closeAutoLock] = useFlag();

  // Ключ хранилища живёт только в памяти вкладки: перезагрузка закрывает его, запуск спросит PIN
  const handleLockNow = useLastCallback(() => {
    lockAppNow();
  });

  const handleChange = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.PasscodeChangePasscodeCurrent });
  });

  // «Скрывать текст в уведомлениях, пока заблокировано» — настройка уведомлений устройства (`notifyPrefs.ts`)
  const handleHideText = useLastCallback((isHidden: boolean) => {
    updateNotifyPrefs({ isLockedTextShown: !isHidden });
  });

  const actionRowClass = buildClassName(styles.setRow, styles.setRowAction);
  const askLabel = lang('ParvanePinAsk');

  return (
    <div
      className={buildClassName('settings-content custom-scroll', styles.screen)}
      data-settings-pin={isEnabled === undefined ? undefined : (isEnabled ? 'on' : 'off')}
    >
      <div className={styles.hint}>{lang('ParvanePinAbout')}</div>
      <div className={styles.caption}>{lang('ParvanePinStartCaption')}</div>
      <div className={styles.group}>
        <div className={styles.setRow}>
          <span className={styles.setTitle}>{askLabel}</span>
          <PvSwitch
            isOn={Boolean(isEnabled)}
            label={askLabel}
            isDisabled={isEnabled === undefined}
            data-pin-toggle
            onChange={handleToggle}
          />
        </div>
        {isEnabled && (
          <button
            type="button"
            className={actionRowClass}
            data-pin-autolock={autoLockMinutes}
            onClick={openAutoLock}
          >
            <span className={styles.setTitle}>{lang('ParvanePinAutoLock')}</span>
            <span className={styles.menuValue}>
              {autoLockMinutes
                ? lang('ParvanePinAutoLockAfter', {
                  time: lang('ParvanePinAutoLockMinutes', { count: autoLockMinutes }, { pluralValue: autoLockMinutes }),
                })
                : lang('ParvanePinAutoLockOff')}
            </span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        )}
        {isEnabled && (
          <button type="button" className={actionRowClass} data-pin-lock-now onClick={handleLockNow}>
            <span className={styles.setTitle}>{lang('ParvanePinLockNow')}</span>
            <span className={styles.setValue}>{IS_MAC_OS ? '⌘L' : 'Ctrl+L'}</span>
          </button>
        )}
        {isEnabled && (
          <ProfileSwitchRow
            title={lang('ParvanePinHideText')}
            isOn={!notifyPrefs.isLockedTextShown}
            onChange={handleHideText}
            data-pin-hide-text
          />
        )}
        {isEnabled && (
          <button type="button" className={actionRowClass} data-pin-change onClick={handleChange}>
            <span className={styles.setTitle}>{lang('ParvanePinChange')}</span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        )}
      </div>
      <div className={styles.hint}>{lang('ParvanePinLimitNote')}</div>
      {isEnabled && <SettingsPasscodeBiometric isActive={isActive} />}
      <SettingsSecurityKeys isActive={isActive} />
      <ProfileChoiceSheet
        isOpen={isAutoLockOpen}
        title={lang('ParvanePinAutoLock')}
        options={autoLockItems}
        selected={String(autoLockMinutes)}
        onSelect={handleAutoLockChange}
        onClose={closeAutoLock}
      />
      {isMigrating && (
        <div className={ownStyles.migration}>
          <Loading />
          <span>{oldLang('ParvaneStorageMigrating')}</span>
        </div>
      )}
      <div className={styles.hint}>{oldLang('ParvaneStoragePinInfo')}</div>
    </div>
  );
};

export default memo(SettingsPasscodeHub);
