import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import buildClassName from '../../../util/buildClassName';
import { getIsFirstRunDone } from '../../../util/parvaneFirstRun';
import {
  markNotifyOnboardShown, readNotifyOnboardState, shouldOfferNotifyOnboard,
} from '../../../util/permissionPrompt';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';
import PvSwitch from '../notes/PvSwitch';

import kit from '../notes/PvKit.module.scss';
import styles from './Permission.module.scss';

// Экран открывается не сразу после входа: приложение успевает показать список чатов
const SHOW_DELAY_MS = 1500;

// «Уведомления — после первого входа, одним экраном с выбором работы в фоне» (доска `ZpSysGen`). Один раз на
// устройство (отметка переживает выход из аккаунта, `deviceWipe.ts`), после выбора модулей первого запуска и только
// пока браузер о разрешении не спрашивал. «Включить» — запрос браузера по нажатию, выбор «в фоне» — push закрытому
// приложению (`hasPushNotifications`)
const NotifyOnboardSheet = () => {
  const { updateWebNotificationSettings } = getActions();
  const lang = useLang();
  const isFirstRunDone = useDerivedState(getIsFirstRunDone);
  const [isOpen, open, close] = useFlag();
  const [isBackground, setIsBackground] = useState(true);

  useEffect(() => {
    if (!shouldOfferNotifyOnboard(readNotifyOnboardState())) return undefined;
    const timer = window.setTimeout(open, SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isFirstRunDone, open]);

  const handleClose = useLastCallback(() => {
    markNotifyOnboardShown();
    close();
  });

  const handleTurnOn = useLastCallback(async () => {
    handleClose();
    const permission = await Notification.requestPermission().catch(() => 'denied');
    if (permission !== 'granted') return;
    updateWebNotificationSettings({ hasWebNotifications: true, hasPushNotifications: isBackground });
  });

  return (
    <PvSheet isOpen={isOpen} title={lang('PvSysNotifyOnboardTitle')} onClose={handleClose}>
      <div className={styles.body} data-notify-onboard>
        <p className={styles.text}>{lang('PvSysNotifyOnboardText')}</p>
        <PvSwitch isOn={isBackground} data-notify-onboard-background onChange={setIsBackground}>
          <span className={kit.rowText}>
            <span className={kit.ttl}>{lang('PvSysNotifyOnboardBackground')}</span>
            <span className={kit.sub}>{lang('PvSysNotifyOnboardBackgroundHint')}</span>
          </span>
        </PvSwitch>
        <div className={styles.buttons}>
          <button type="button" className={kit.btn} data-notify-onboard-action="later" onClick={handleClose}>
            {lang('PvSysNotNow')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            data-notify-onboard-action="on"
            onClick={handleTurnOn}
          >
            {lang('PvSysNotifyOnboardOn')}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(NotifyOnboardSheet);
