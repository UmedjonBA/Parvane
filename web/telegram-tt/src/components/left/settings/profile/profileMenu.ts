import type { ProfileIconName } from './ProfileIcon';
import { SettingsScreens } from '../../../../types';

// Parvane (spec 041 E3): пункты «Профиля» — один список для экрана телефона и колонки компьютера
// (доски `PhoneProfile`, `DeskProfile`). Пункт без экрана — действие (выход)
export type ProfileItemId = 'overview' | 'modules' | 'appearance' | 'notifications' | 'language' | 'devices'
  | 'privacy' | 'keys' | 'data' | 'export' | 'messenger' | 'help' | 'bug' | 'about' | 'signOut';

export type ProfileItem = {
  id: ProfileItemId;
  icon: ProfileIconName;
  titleKey: 'ParvaneProfileOverview' | 'ParvaneModules' | 'ParvaneAppearance' | 'Notifications' | 'Language'
    | 'ParvaneProfileDevices' | 'PrivacySettings' | 'ParvaneProfileKeys' | 'DataSettings' | 'ParvaneExportData'
    | 'ParvaneProfileMessengerSettings' | 'ParvaneHelpTitle' | 'MenuReportBug' | 'ParvaneProfileAbout'
    | 'LogOutTitle';
  screen?: SettingsScreens;
  // Только в колонке компьютера: на телефоне «Обзор» — сам экран «Профиля»
  isNavOnly?: boolean;
  isAccent?: boolean;
  isDanger?: boolean;
};

export type ProfileGroup = {
  id: 'top' | 'app' | 'account' | 'data' | 'more';
  titleKey?: 'ParvaneProfileGroupApp' | 'ParvaneProfileGroupAccount' | 'ParvaneProfileGroupData' | 'MenuMore';
  items: ProfileItem[];
};

export const PROFILE_GROUPS: ProfileGroup[] = [{
  id: 'top',
  items: [{
    id: 'overview',
    icon: 'overview',
    titleKey: 'ParvaneProfileOverview',
    screen: SettingsScreens.Main,
    isNavOnly: true,
  }],
}, {
  id: 'app',
  titleKey: 'ParvaneProfileGroupApp',
  items: [
    {
      id: 'modules',
      icon: 'modules',
      titleKey: 'ParvaneModules',
      screen: SettingsScreens.ParvaneModules,
      isAccent: true,
    },
    { id: 'appearance', icon: 'brush', titleKey: 'ParvaneAppearance', screen: SettingsScreens.ParvaneAppearance },
    { id: 'notifications', icon: 'bell', titleKey: 'Notifications', screen: SettingsScreens.Notifications },
    { id: 'language', icon: 'globe', titleKey: 'Language', screen: SettingsScreens.Language },
  ],
}, {
  id: 'account',
  titleKey: 'ParvaneProfileGroupAccount',
  items: [
    { id: 'devices', icon: 'laptop', titleKey: 'ParvaneProfileDevices', screen: SettingsScreens.ActiveSessions },
    { id: 'privacy', icon: 'lock', titleKey: 'PrivacySettings', screen: SettingsScreens.Privacy },
    { id: 'keys', icon: 'key', titleKey: 'ParvaneProfileKeys', screen: SettingsScreens.ParvaneKeysBackup },
  ],
}, {
  id: 'data',
  titleKey: 'ParvaneProfileGroupData',
  items: [
    { id: 'data', icon: 'disk', titleKey: 'DataSettings', screen: SettingsScreens.DataStorage },
    { id: 'export', icon: 'download', titleKey: 'ParvaneExportData', screen: SettingsScreens.ParvaneExport },
  ],
}, {
  id: 'more',
  titleKey: 'MenuMore',
  items: [
    { id: 'messenger', icon: 'chat', titleKey: 'ParvaneProfileMessengerSettings', screen: SettingsScreens.General },
    { id: 'help', icon: 'help', titleKey: 'ParvaneHelpTitle', screen: SettingsScreens.ParvaneHelp },
    { id: 'bug', icon: 'bug', titleKey: 'MenuReportBug', screen: SettingsScreens.ParvaneBugReport },
    { id: 'about', icon: 'info', titleKey: 'ParvaneProfileAbout', screen: SettingsScreens.ParvaneAbout },
    { id: 'signOut', icon: 'logout', titleKey: 'LogOutTitle', isDanger: true },
  ],
}];

const APPEARANCE_SCREENS = [
  SettingsScreens.ParvaneAppearance, SettingsScreens.GeneralChatBackground,
  SettingsScreens.GeneralChatBackgroundColor, SettingsScreens.Performance,
];

const MESSENGER_SCREENS = [
  SettingsScreens.General, SettingsScreens.Stickers, SettingsScreens.QuickReaction, SettingsScreens.CustomEmoji,
];

const ROOT_SCREENS = new Set(PROFILE_GROUPS.flatMap((group) => group.items)
  .map((item) => item.screen).filter((screen) => screen !== undefined));

/** Экран открыт прямо из списка «Профиля»: на компьютере у него нет стрелки «Назад». */
export function getIsProfileRootScreen(screen: SettingsScreens) {
  return ROOT_SCREENS.has(screen);
}

/** Пункт «Профиля», которому принадлежит экран настроек (вложенные экраны — пункт своего раздела). */
export function getProfileItemId(screen: SettingsScreens): ProfileItemId {
  const name = SettingsScreens[screen];
  if (screen === SettingsScreens.ParvaneModules) return 'modules';
  if (APPEARANCE_SCREENS.includes(screen)) return 'appearance';
  if (screen === SettingsScreens.Notifications) return 'notifications';
  if (screen === SettingsScreens.Language || screen === SettingsScreens.DoNotTranslate) return 'language';
  if (screen === SettingsScreens.ActiveSessions || screen === SettingsScreens.ParvaneDeleteAccount) return 'devices';
  if (screen === SettingsScreens.ParvaneExport) return 'export';
  if (screen === SettingsScreens.ParvaneHelp) return 'help';
  if (screen === SettingsScreens.ParvaneBugReport) return 'bug';
  if (screen === SettingsScreens.ParvaneKeysBackup) return 'keys';
  if (screen === SettingsScreens.DataStorage) return 'data';
  if (screen === SettingsScreens.ParvaneAbout || screen === SettingsScreens.Experimental) return 'about';
  if (MESSENGER_SCREENS.includes(screen) || name.startsWith('Folders')) return 'messenger';
  if (/^(Privacy|Passcode|TwoFa|ActiveWebsites|Passkeys)/.test(name)) return 'privacy';
  return 'overview';
}
