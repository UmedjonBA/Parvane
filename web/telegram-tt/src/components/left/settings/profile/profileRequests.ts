// Разовые просьбы между экранами «Профиля»: карточка аккаунта на «Устройствах» открывает «Конфиденциальность» сразу с
// раскрытой формой смены пароля (доска `DkSettingsA`, строка «Пароль · сменить»)

let isPasswordFormRequested = false;

export function requestPasswordForm() {
  isPasswordFormRequested = true;
}

/** Просьба открыть форму пароля была — и снимается. */
export function consumePasswordFormRequest() {
  const isRequested = isPasswordFormRequested;
  isPasswordFormRequested = false;
  return isRequested;
}

// «Готово» в шапке «Изменить профиль» (доска `XpProfile`): кнопку рисует шапка, сохраняет сам экран
let profileSaveHandler: NoneToVoidFunction | undefined;

export function setProfileSaveHandler(handler: NoneToVoidFunction | undefined) {
  profileSaveHandler = handler;
}

export function runProfileSave() {
  profileSaveHandler?.();
}
