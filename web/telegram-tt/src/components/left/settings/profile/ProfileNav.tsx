import { memo } from '../../../../lib/teact/teact';

import type { SettingsScreens } from '../../../../types';

import buildClassName from '../../../../util/buildClassName';
import { getProfileItemId } from './profileMenu';

import useLang from '../../../../hooks/useLang';

import ProfileMenu from './ProfileMenu';

import styles from './Profile.module.scss';

type OwnProps = {
  currentScreen: SettingsScreens;
};

// Parvane (spec 041 E3): левая колонка «Профиля» на компьютере — разделы без значков и без шапки аккаунта
// (доски `RdProfile`, `DkSettingsA`, `ZdProfileX` новее `DeskProfile`); аккаунт — в «Обзоре»
const ProfileNav = ({ currentScreen }: OwnProps) => {
  const lang = useLang();
  return (
    <nav
      className={buildClassName(styles.nav, 'custom-scroll')}
      aria-label={lang('ParvaneProfileTitle')}
      data-profile-menu="nav"
    >
      <ProfileMenu variant="nav" activeId={getProfileItemId(currentScreen)} />
    </nav>
  );
};

export default memo(ProfileNav);
