import { memo } from '../../../../lib/teact/teact';

import { closeProfileWindow, getProfileWindow } from './profileRequests';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';

import Modal from '../../../ui/Modal';
import SettingsDeleteAccount from '../account/SettingsDeleteAccount';
import SettingsEditProfile from '../SettingsEditProfile';

import styles from './Profile.module.scss';

// Окна поверх «Профиля» на компьютере (доска `RdProfile`): «Мой профиль» с «Отмена / Сохранить» и «Удалить аккаунт».
// Открываются `openProfileWindow` из «Обзора» и карточек «Устройств и аккаунта»; на телефоне те же формы — экранами
const ProfileWindows = () => {
  const lang = useLang();
  const kind = useDerivedState(getProfileWindow);

  return (
    <>
      <Modal
        isOpen={kind === 'edit'}
        title={lang('ParvaneProfileMine')}
        hasCloseButton
        className={styles.profileWindow}
        onClose={closeProfileWindow}
      >
        <SettingsEditProfile isActive={kind === 'edit'} isWindow onReset={closeProfileWindow} />
      </Modal>
      <Modal
        isOpen={kind === 'delete'}
        title={lang('ParvaneDeleteAccountTitle')}
        hasCloseButton
        className={styles.profileWindow}
        onClose={closeProfileWindow}
      >
        <SettingsDeleteAccount isActive={kind === 'delete'} isWindow onReset={closeProfileWindow} />
      </Modal>
    </>
  );
};

export default memo(ProfileWindows);
