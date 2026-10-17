import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ParvaneIcon from '../../main/ParvaneIcon';
import ConfirmDialog from '../../ui/ConfirmDialog';
import ListItem from '../../ui/ListItem';

import styles from './SettingsMain.module.scss';

// Parvane: выход — последней строкой «Профиля», как в прототипе (меню «⋯» в шапке нет). Выход с единственного
// устройства стирает ключи — диалог предупреждает про ключ восстановления
const SettingsSignOut = () => {
  const { signOut } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [isOpen, setIsOpen] = useState(false);
  const [isLastDevice, setIsLastDevice] = useState(false);

  const open = useLastCallback(() => {
    setIsLastDevice(false);
    setIsOpen(true);
    void (callApi as unknown as (name: string) => Promise<boolean | undefined>)('parvaneIsLastDevice')
      .then((isLast) => setIsLastDevice(Boolean(isLast)));
  });

  const close = useLastCallback(() => setIsOpen(false));

  const confirm = useLastCallback(() => {
    close();
    signOut({ forceInitApi: true });
  });

  return (
    <div className={styles.card} data-settings-sign-out>
      <ListItem className={styles.screenRow} onClick={open}>
        <span className={styles.dangerTile}><ParvaneIcon name="logout" isSmall /></span>
        <span className={styles.rowText}>
          <span className={buildClassName(styles.rowTitle, styles.dangerTitle)}>{lang('LogOutTitle')}</span>
        </span>
      </ListItem>
      <ConfirmDialog
        isOpen={isOpen}
        onClose={close}
        text={oldLang(isLastDevice ? 'ParvaneLogoutLastDevice' : 'lng_sure_logout')}
        confirmLabel={oldLang('AccountSettings.Logout')}
        confirmHandler={confirm}
        confirmIsDestructive
      />
    </div>
  );
};

export default memo(SettingsSignOut);
