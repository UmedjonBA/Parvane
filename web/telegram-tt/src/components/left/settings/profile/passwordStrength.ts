// Оценка нового пароля в окне «Сменить пароль» (доска `ZdProfileX`: «Надёжный: 12 знаков, есть цифры»). Правило
// сервера одно — не короче 8 знаков (`identity` `password_policy_ok`); остальное — подсказка, а не запрет

export const PASSWORD_MIN_LENGTH = 8;
const STRONG_LENGTH = 12;
const STRONG_KINDS = 2;

export type PasswordStrength = {
  level: 'short' | 'fair' | 'strong';
  length: number;
  hasDigits: boolean;
  hasLetters: boolean;
  hasSymbols: boolean;
};

export function measurePassword(password: string): PasswordStrength {
  const length = [...password].length;
  const hasDigits = /\d/u.test(password);
  const hasLetters = /\p{L}/u.test(password);
  const hasSymbols = /[^\p{L}\d]/u.test(password);
  const kinds = Number(hasDigits) + Number(hasLetters) + Number(hasSymbols);
  const level = length < PASSWORD_MIN_LENGTH ? 'short'
    : length >= STRONG_LENGTH && kinds >= STRONG_KINDS ? 'strong' : 'fair';
  return {
    level, length, hasDigits, hasLetters, hasSymbols,
  };
}
