import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { SettingsScreens } from '../../../../types';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';

import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import Loading from '../../../ui/Loading';
import ProfileIcon from '../profile/ProfileIcon';

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

  const handleLockNow = useLastCallback(() => {
    // Ключ хранилища живёт только в памяти вкладки: перезагрузка закрывает его, запуск спросит PIN
    window.location.reload();
  });

  const handleChange = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.PasscodeChangePasscodeCurrent });
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
          <button
            type="button"
            role="switch"
            className={buildClassName(styles.switch, isEnabled && styles.switchOn)}
            aria-checked={Boolean(isEnabled)}
            aria-label={askLabel}
            data-pin-toggle
            disabled={isEnabled === undefined}
            onClick={handleToggle}
          />
        </div>
        {isEnabled && (
          <button type="button" className={actionRowClass} data-pin-lock-now onClick={handleLockNow}>
            <span className={styles.setTitle}>{lang('ParvanePinLockNow')}</span>
          </button>
        )}
        {isEnabled && (
          <button type="button" className={actionRowClass} data-pin-change onClick={handleChange}>
            <span className={styles.setTitle}>{lang('ParvanePinChange')}</span>
            <ProfileIcon name="right" isSmall className={styles.menuChevron} />
          </button>
        )}
      </div>
      <div className={styles.hint}>{lang('ParvanePinLimitNote')}</div>
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
