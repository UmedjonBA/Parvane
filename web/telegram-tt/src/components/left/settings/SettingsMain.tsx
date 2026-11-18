import { APP_REVISION } from 'virtual:git-info';
import { memo, useEffect, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiUser } from '../../../api/types';
import type { ThemeKey } from '../../../types';
import type { ProfileItemId } from './profile/profileMenu';

import { APP_NAME, DEBUG, IS_BETA } from '../../../config';
import { selectTheme, selectUser } from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { IS_MULTIACCOUNT_SUPPORTED } from '../../../util/browser/globalEnvironment';
import buildClassName from '../../../util/buildClassName';
import { getColorScheme } from '../../../util/colorScheme';

import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useParvaneModules from '../../../hooks/useParvaneModules';

import { SCHEME_NAMES } from '../../common/ColorSchemePicker';
import ProfileHead from './profile/ProfileHead';
import ProfileMenu from './profile/ProfileMenu';
import ProfileOverview from './profile/ProfileOverview';
import SettingsAccounts from './SettingsAccounts';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  currentUserId?: string;
  currentUser?: ApiUser;
  theme: ThemeKey;
  shouldUseSystemTheme?: boolean;
  deviceCount: number;
};

const VERSION = IS_BETA ? `${APP_VERSION} Beta (${APP_REVISION})` : (DEBUG ? APP_REVISION : APP_VERSION);

// Parvane (spec 041 E3): главный экран «Профиля». Телефон (доска `PhoneProfile`) — аккаунт с «Избранным»,
// «Контактами» и «Архивом» и разделы списком; компьютер (доска `DeskProfile`) — «Обзор», разделы стоят в
// колонке слева (`profile/ProfileNav`)
const SettingsMain = ({
  isActive,
  currentUserId,
  currentUser,
  theme,
  shouldUseSystemTheme,
  deviceCount,
  onReset,
}: OwnProps & StateProps) => {
  const { loadAuthorizations, loadMoreProfilePhotos } = getActions();

  const lang = useLang();
  const { isDesktop } = useAppLayout();
  const colorScheme = useDerivedState(getColorScheme);
  const { states: modules } = useParvaneModules();

  useEffect(() => {
    if (currentUserId) {
      loadMoreProfilePhotos({ peerId: currentUserId, isPreload: true });
    }
  }, [currentUserId]);

  // Parvane: устройства могли добавиться/отозваться после старта приложения —
  // перечитываем список при каждом заходе в настройки
  useEffect(() => {
    if (isActive) {
      loadAuthorizations();
    }
  }, [isActive]);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const modeName = lang(shouldUseSystemTheme ? 'ParvaneThemeAuto' : theme === 'dark'
    ? 'ParvaneThemeDark' : 'ParvaneThemeLight').toLowerCase();

  const values = useMemo<Partial<Record<ProfileItemId, string>>>(() => ({
    modules: lang('ParvaneProfileModulesCount', {
      count: modules.filter((module) => module.isOn).length, total: modules.length,
    }),
    appearance: `${SCHEME_NAMES[colorScheme]} · ${modeName}`,
    language: lang.languageInfo.nativeName,
    devices: deviceCount ? String(deviceCount) : undefined,
    export: 'ZIP',
  }), [lang, modules, colorScheme, modeName, deviceCount]);

  if (isDesktop) return <ProfileOverview />;

  return (
    <div className={buildClassName(styles.main, 'settings-main-scroll', 'custom-scroll')} data-profile-menu="list">
      <ProfileHead variant="phone" />
      {IS_MULTIACCOUNT_SUPPORTED && currentUser && <SettingsAccounts currentUser={currentUser} />}
      <ProfileMenu variant="list" values={values} />
      <div className={styles.version}>{lang('ParvaneProfileVersion', { name: APP_NAME, version: VERSION })}</div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { currentUserId, activeSessions } = global;
    const { shouldUseSystemTheme } = selectSharedSettings(global);

    return {
      currentUserId,
      currentUser: currentUserId ? selectUser(global, currentUserId) : undefined,
      theme: selectTheme(global),
      shouldUseSystemTheme,
      deviceCount: activeSessions.orderedHashes.length,
    };
  },
)(SettingsMain));
