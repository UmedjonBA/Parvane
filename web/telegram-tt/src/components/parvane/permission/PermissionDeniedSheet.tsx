import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { PermissionKind } from '../../../util/permissionPrompt';

import buildClassName from '../../../util/buildClassName';
import { closePermissionDenied, getDeniedPermission, queryPermission } from '../../../util/permissionPrompt';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Permission.module.scss';

const TITLE_KEYS = {
  microphone: 'PvSysPermTitleMicrophone',
  camera: 'PvSysPermTitleCamera',
  notifications: 'PvSysPermTitleNotifications',
  location: 'PvSysPermTitleLocation',
} as const satisfies Record<PermissionKind, string>;
const NAME_KEYS = {
  microphone: 'PvSysPermNameMicrophone',
  camera: 'PvSysPermNameCamera',
  notifications: 'PvSysPermNameNotifications',
  location: 'PvSysPermNameLocation',
} as const satisfies Record<PermissionKind, string>;

// «Нет доступа» (доска `ZpSysGen`: «если отказать, функция покажет кнопку „Открыть настройки“ вместо повторного
// запроса»): браузер запомнил отказ и сам не спросит, открыть его настройки страница не может — экран говорит, где
// разрешить, и проверяет снова. Один на приложение (`ParvaneSystemHost`), открывает `showPermissionDenied`
const PermissionDeniedSheet = () => {
  const lang = useLang();
  const kind = useDerivedState(getDeniedPermission);
  const [isStillDenied, setIsStillDenied] = useState(false);

  useLayoutEffect(() => {
    setIsStillDenied(false);
  }, [kind]);

  const handleCheck = useLastCallback(async () => {
    if (!kind) return;
    const answer = await queryPermission(kind);
    if (answer === 'denied') {
      setIsStillDenied(true);
      return;
    }
    closePermissionDenied();
  });

  return (
    <PvSheet isOpen={Boolean(kind)} title={kind && lang(TITLE_KEYS[kind])} onClose={closePermissionDenied}>
      {kind && (
        <div className={styles.body} data-permission-denied={kind}>
          <p className={styles.text}>{lang('PvSysPermDeniedText', { what: lang(NAME_KEYS[kind]) })}</p>
          <p className={buildClassName(styles.text, kit.muted)}>{lang('PvSysPermDeniedApp')}</p>
          {isStillDenied && (
            <p className={buildClassName(styles.text, styles.warn)} role="alert">{lang('PvSysPermStillDenied')}</p>
          )}
          <div className={styles.buttons}>
            <button type="button" className={kit.btn} onClick={closePermissionDenied}>{lang('OK')}</button>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              data-permission-check
              onClick={handleCheck}
            >
              {lang('PvSysPermCheck')}
            </button>
          </div>
        </div>
      )}
    </PvSheet>
  );
};

export default memo(PermissionDeniedSheet);
