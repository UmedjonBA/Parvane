const LEGACY_CREDS_STORAGE_KEY = 'parvane:creds';
const LOGIN_ADDRESS_STORAGE_KEY = 'parvane:login-address';
const REMEMBER_ME_STORAGE_KEY = 'parvane:remember-me';
const LAST_ACTIVE_STORAGE_KEY = 'parvane:last-active';
// «Оставаться в системе» действует, пока устройством пользуются: после 180 суток
// без активности (окно продления сессии на сервере) вход снова через экран пароля.
// Прежний срок — сутки — вместе с суточным токеном ежедневно возвращал на экран пароля
export const SESSION_IDLE_LIMIT_MS = 180 * 24 * 60 * 60 * 1000;

export type LoginCredentials = { user: string; password: string };

export function parseLoginCredentials(raw: string): LoginCredentials | undefined {
  const colonIndex = raw.indexOf(':');
  if (colonIndex <= 0 || colonIndex === raw.length - 1) return undefined;
  return { user: raw.slice(0, colonIndex), password: raw.slice(colonIndex + 1) };
}

export function consumeLegacyCredentials() {
  const saved = localStorage.getItem(LEGACY_CREDS_STORAGE_KEY);
  localStorage.removeItem(LEGACY_CREDS_STORAGE_KEY);
  return saved ? parseLoginCredentials(saved) : undefined;
}

export function saveLoginAddress(user: string) {
  localStorage.setItem(LOGIN_ADDRESS_STORAGE_KEY, user);
}

export function readLoginAddress() {
  return localStorage.getItem(LOGIN_ADDRESS_STORAGE_KEY) || undefined;
}

export function saveRememberMe(value: boolean) {
  localStorage.setItem(REMEMBER_ME_STORAGE_KEY, value ? '1' : '0');
}

// Дефолт (ключа нет) — true, как auth.rememberMe в initialState tt.
export function readRememberMe() {
  return localStorage.getItem(REMEMBER_ME_STORAGE_KEY) !== '0';
}

export function touchSessionActivity(now = Date.now()) {
  try {
    localStorage.setItem(LAST_ACTIVE_STORAGE_KEY, String(now));
  } catch {
    // приватный режим — сессию не продлеваем
  }
}

export function readSessionActivity() {
  const raw = localStorage.getItem(LAST_ACTIVE_STORAGE_KEY);
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

// Без отметки активности (старые сессии) — считаем сессию свежей и ставим
// отметку; просрочена, если тишина дольше SESSION_IDLE_LIMIT_MS
export function isSessionExpired(now = Date.now(), limitMs = SESSION_IDLE_LIMIT_MS) {
  const lastActive = readSessionActivity();
  if (lastActive === undefined) return false;
  return now - lastActive > limitMs;
}

// Поля токена сессии, нужные клиенту: срок и устройство. Подпись проверяет сервер
export function readTokenClaims(jwt: string): { iat?: number; exp?: number; dev?: string } | undefined {
  try {
    const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(payload)) as { iat?: unknown; exp?: unknown; dev?: unknown };
    return {
      iat: typeof parsed.iat === 'number' ? parsed.iat : undefined,
      exp: typeof parsed.exp === 'number' ? parsed.exp : undefined,
      dev: typeof parsed.dev === 'string' && parsed.dev ? parsed.dev : undefined,
    };
  } catch {
    return undefined;
  }
}

// Токен пора продлевать: прошла половина его срока (или срок вышел). Продление
// идёт заранее, чтобы открытая вкладка не дожидалась отказа сервера
export function isTokenDueForRenewal(jwt: string, now = Date.now()) {
  const claims = readTokenClaims(jwt);
  if (!claims?.exp) return false;
  const issuedAt = claims.iat ?? claims.exp;
  return now / 1000 >= issuedAt + (claims.exp - issuedAt) / 2;
}

export function clearLoginStorage() {
  localStorage.removeItem(LEGACY_CREDS_STORAGE_KEY);
  localStorage.removeItem(LOGIN_ADDRESS_STORAGE_KEY);
  localStorage.removeItem(REMEMBER_ME_STORAGE_KEY);
  localStorage.removeItem(LAST_ACTIVE_STORAGE_KEY);
}

export const authStorageKeys = {
  legacyCredentials: LEGACY_CREDS_STORAGE_KEY,
  loginAddress: LOGIN_ADDRESS_STORAGE_KEY,
  rememberMe: REMEMBER_ME_STORAGE_KEY,
};
