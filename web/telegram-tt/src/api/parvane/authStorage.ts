const LEGACY_CREDS_STORAGE_KEY = 'parvane:creds';
const LOGIN_ADDRESS_STORAGE_KEY = 'parvane:login-address';

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

export function clearLoginStorage() {
  localStorage.removeItem(LEGACY_CREDS_STORAGE_KEY);
  localStorage.removeItem(LOGIN_ADDRESS_STORAGE_KEY);
}

export const authStorageKeys = {
  legacyCredentials: LEGACY_CREDS_STORAGE_KEY,
  loginAddress: LOGIN_ADDRESS_STORAGE_KEY,
};
