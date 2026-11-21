// Почта аккаунта в «Устройствах и аккаунте» (доска `PhProfileB`: «Почта»). Сервер почту обратно не отдаёт — её
// помнит устройство, на котором аккаунт создавали; на остальных строки нет. Стирается при выходе (`parvane:*`)
const EMAIL_PREFIX = 'parvane:account-email:';

export function rememberAccountEmail(nick: string, email: string) {
  if (!email) return;
  try {
    localStorage.setItem(`${EMAIL_PREFIX}${nick}`, email);
  } catch {
    // Строки «Почта» просто не будет
  }
}

export function readAccountEmail(nick: string | undefined) {
  if (!nick) return undefined;
  try {
    return localStorage.getItem(`${EMAIL_PREFIX}${nick}`) || undefined;
  } catch {
    return undefined;
  }
}
