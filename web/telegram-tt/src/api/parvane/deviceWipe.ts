import { ASSET_CACHE_NAME, LANG_CACHE_NAME } from '../../config';
import { MAIN_IDB_STORE } from '../../util/browser/idb';
import { clearDiag } from '../../util/parvaneDiag';
import { ACCOUNT_WIPED_EVENT } from '../../util/parvaneEvents';
import { resetPinAttempts } from '../../util/pinAttempts';
import { clearWorkerReminders } from '../../util/reminderStore';
import { clearLoginStorage } from './authStorage';
import { clearSavedGifs } from './gifs';
import { clearSecureSession, SecureE2eStorage } from './secureStorage';

// Стереть данные аккаунта на устройстве (spec 041 E6): полный выход из «Профиля» и выход с экрана блокировки
// (пятый неверный PIN, «Забыли PIN?»). PIN не нужен: хранилище профиля стирается целиком, не расшифровываясь.
// Остаются только настройки устройства, не аккаунта, и оболочка приложения PWA

// localStorage: схема, набор и порядок модулей (свои у каждого устройства, MODULES-1) и отметка первого запуска,
// ширина колонок, плотность списка чатов, адрес gateway и метки сценариев e2e. Всё прочее `parvane:*` — данные аккаунта и его экранов
const KEPT_LOCAL_KEYS = new Set([
  'parvane:color-scheme', 'parvane:modules', 'parvane:modules-view', 'parvane:modules-server-off',
  'parvane:modules-first-run', 'parvane:panel-widths', 'parvane:gateway', 'parvane:chat-list-dense',
  // Экран «Уведомления» после первого входа (доска `ZpSysGen`) — один раз на устройство
  'parvane:notify-onboard',
]);
const KEPT_LOCAL_PREFIXES = ['parvane:e2e:'];
const ACCOUNT_PREFIX = 'parvane:';
// Кэши, которые не данные аккаунта: оболочка приложения (запуск без сети) и языковые пакеты
const KEPT_CACHE_PREFIXES = [ASSET_CACHE_NAME, LANG_CACHE_NAME.replace(/\d+$/, '')];
// Записи общей базы `tt-data` с настройками аккаунта (уведомления, фон чатов по темам)
const ACCOUNT_IDB_KEYS = ['parvane-account-settings', 'parvane-theme-settings'];

export async function wipeAccountFromDevice(user: string | undefined) {
  clearLoginStorage();
  if (user) {
    // Профиль хранилища стирается вместе с базой — и запертый PIN тоже
    await SecureE2eStorage.clear(user).catch(() => undefined);
    await clearSecureSession(user).catch(() => undefined);
  }
  await Promise.all([
    clearWorkerReminders().catch(() => undefined),
    clearSavedGifs().catch(() => undefined),
    MAIN_IDB_STORE.delMany(ACCOUNT_IDB_KEYS).catch(() => undefined),
    clearAccountCaches(),
  ]);
  // Модули забывают память вкладки до чистки хранилища страницы: их запись при сбросе тоже стирается
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_WIPED_EVENT));
  // Счётчик неверных PIN живёт и в памяти вкладки: новый вход начинает с полного числа попыток
  if (user) resetPinAttempts(user);
  clearAccountStorage(localStorage, user);
  clearAccountStorage(sessionStorage, user);
  try {
    clearDiag();
  } catch {
    // Журнал недоступен — стирание не должно падать
  }
}

/** Ключи хранилища страницы, которые стираются: `parvane:*` кроме настроек устройства и всё с адресом аккаунта. */
export function selectAccountStorageKeys(keys: string[], user: string | undefined) {
  return keys.filter((key) => (key.startsWith(ACCOUNT_PREFIX) && !isKeptLocalKey(key))
    || Boolean(user && key.includes(user)));
}

/** Кэши Cache Storage, которые стираются: всё, кроме оболочки приложения и языковых пакетов. */
export function selectAccountCaches(names: string[]) {
  return names.filter((name) => !KEPT_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

function isKeptLocalKey(key: string) {
  return KEPT_LOCAL_KEYS.has(key) || KEPT_LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function clearAccountStorage(storage: Storage, user: string | undefined) {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index) || '');
    selectAccountStorageKeys(keys, user).forEach((key) => storage.removeItem(key));
  } catch {
    // Хранилище страницы недоступно (приватный режим) — стирать нечего
  }
}

async function clearAccountCaches() {
  if (typeof caches === 'undefined') return;
  try {
    const names = selectAccountCaches(await caches.keys());
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch {
    // Cache Storage недоступен — стирать нечего
  }
}
