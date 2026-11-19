// Ник нового аккаунта (зеркало `valid_nick` в identity). Полный адрес `user@server` тоже принимается
const NICK_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/i;
const FULL_ADDRESS_PATTERN = /^[^@\s]+@[^@\s]+$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const MIN_PASSWORD_LENGTH = 8;

export function checkIsNickOrAddress(value: string) {
  const trimmed = value.trim();
  return NICK_PATTERN.test(trimmed) || FULL_ADDRESS_PATTERN.test(trimmed);
}

export function checkIsEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim());
}

/** Ник без сервера: в поле входа адрес аккаунта показывается так же, как его вводят. */
export function getNickOfAddress(address: string) {
  return address.split('@')[0];
}

/** Сервер аккаунта — узел страницы: web ходит в gateway того же адреса. */
export function getAuthServer() {
  return window.location.host;
}

/** Номер шага регистрации: без подтверждения на сервере шагов два — форма и ключ восстановления. */
export function countRegistrationSteps(confirm: 'none' | 'email' | 'telegram' | undefined) {
  return confirm && confirm !== 'none' ? 3 : 2;
}

/**
 * Значение поля формы прямо из разметки: отправка может прийти раньше отрисовки набранного (вставка и Enter
 * менеджером паролей), состояние компонента к этому мигу ещё прежнее.
 */
export function readFormValue(form: HTMLFormElement, id: string) {
  return (form.elements.namedItem(id) as HTMLInputElement).value;
}
