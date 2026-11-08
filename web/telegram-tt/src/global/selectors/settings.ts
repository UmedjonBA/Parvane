import type { GlobalState } from '../types';

import { ACCOUNT_SLOT, getAccountsInfo } from '../../util/multiaccount';
import { selectSharedSettings } from './sharedState';

const IS_PARVANE_TT_PASSCODE_DISABLED = true;

export function selectNotifyDefaults<T extends GlobalState>(global: T) {
  return global.settings.notifyDefaults;
}

export function selectNotifyException<T extends GlobalState>(global: T, chatId: string) {
  return global.chats.notifyExceptionById?.[chatId];
}

export function selectLanguageCode<T extends GlobalState>(global: T) {
  return selectSharedSettings(global).language.replace('-raw', '');
}

export function selectCanSetPasscode<T extends GlobalState>(global: T) {
  // Parvane: код-пароль Telegram Web A шифрует сессию MTProto, а не данные Parvane; блокировка Parvane — «PIN
  // хранилища». Экран и горячие клавиши Ctrl/Alt/Meta+Shift+L отключены (C4 ревью 7 ноя 2026)
  if (IS_PARVANE_TT_PASSCODE_DISABLED) return false;
  // TODO[passcode]: remove this when multiacc passcode is implemented
  const accounts = getAccountsInfo();
  return global.auth.rememberMe && !ACCOUNT_SLOT && Object.keys(accounts).length === 1;
}

export function selectTranslationLanguage<T extends GlobalState>(global: T) {
  return global.settings.byKey.translationLanguage || selectLanguageCode(global);
}

export function selectShouldHideReadMarks<T extends GlobalState>(global: T) {
  return global.settings.byKey.shouldHideReadMarks;
}

export function selectSettingsKeys<T extends GlobalState>(global: T) {
  return global.settings.byKey;
}

export function selectTimezones<T extends GlobalState>(global: T) {
  return global.timezones?.byId;
}
