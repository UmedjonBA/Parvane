import { createSignal } from '../../../../util/signals';

// Разовые просьбы между экранами «Профиля». Карточка копии ключей на «Данных и памяти» (доска `DkSettingsB`) открывает
// экран «Копия ключей» сразу на нужной вкладке формы файла копии
export type KeysFileTab = 'save' | 'restore';

let requestedKeysTab: KeysFileTab | undefined;

export function requestKeysFileTab(tab: KeysFileTab) {
  requestedKeysTab = tab;
}

/** Просьба открыть вкладку была — и снимается. */
export function consumeKeysFileTab() {
  const tab = requestedKeysTab;
  requestedKeysTab = undefined;
  return tab;
}

// Окна поверх «Профиля» на компьютере (доска `RdProfile`): «Мой профиль» и «Удалить аккаунт». На телефоне это экраны
export type ProfileWindow = 'edit' | 'delete';

const [getProfileWindow, setProfileWindow] = createSignal<ProfileWindow | undefined>(undefined);

export { getProfileWindow };

export function openProfileWindow(kind: ProfileWindow) {
  setProfileWindow(kind);
}

export function closeProfileWindow() {
  setProfileWindow(undefined);
}

// Значок поиска в шапке «Справки Parvane» (доска `RpProfileA`): открывает поле поиска на самом экране
const [getIsHelpSearchOpen, setIsHelpSearchOpen] = createSignal(false);

export { getIsHelpSearchOpen, setIsHelpSearchOpen };

export function toggleHelpSearch() {
  setIsHelpSearchOpen(!getIsHelpSearchOpen());
}

// «Готово» в шапке «Изменить профиль» (доска `XpProfile`): кнопку рисует шапка, сохраняет сам экран
let profileSaveHandler: NoneToVoidFunction | undefined;

export function setProfileSaveHandler(handler: NoneToVoidFunction | undefined) {
  profileSaveHandler = handler;
}

export function runProfileSave() {
  profileSaveHandler?.();
}
