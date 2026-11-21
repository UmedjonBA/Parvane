// Parvane (доска `RpProfileC`): «Выгрузить мои данные» на экране аккаунта, ждущего удаления. Выгрузка идёт в самом
// приложении, а сессию такому аккаунту сервер выдаёт только с отменой удаления, — экран входа оставляет просьбу,
// и после входа оболочка сразу открывает «Выгрузить мои данные». Просьба живёт в вкладке (sessionStorage)

const EXPORT_AFTER_LOGIN_KEY = 'parvane:export-after-login';

export function requestExportAfterLogin() {
  try {
    sessionStorage.setItem(EXPORT_AFTER_LOGIN_KEY, '1');
  } catch {
    // Хранилище недоступно: после входа выгрузку откроют руками
  }
}

/** Просьба была — и снимается. */
export function consumeExportAfterLogin() {
  try {
    const isRequested = sessionStorage.getItem(EXPORT_AFTER_LOGIN_KEY) === '1';
    sessionStorage.removeItem(EXPORT_AFTER_LOGIN_KEY);
    return isRequested;
  } catch {
    return false;
  }
}
