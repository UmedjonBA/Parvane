import { getActions, getGlobal } from '../global';

// «Обновление» в «О приложении» (доски `RpProfileA`, `ZdProfileX`). Новая сборка на своём сервере видна по
// `version.txt` (идентификатор сборки, как в `checkAppVersion`); «Обновить» — перезагрузка, страница «сначала из
// сети» берёт новую сборку (PWA F1). «Обновлять автоматически» (по умолчанию включено): найденная новая сборка
// ставится, когда приложение уходит в фон и звонка нет — посреди работы страница не перезагружается
const VERSION_URL = 'version.txt';
const BUILD_ID_RE = /^[\w.-]{1,64}$/;
const AUTO_KEY = 'parvane:auto-update';
const CHECKED_KEY = 'parvane:update-checked-at';
const ENDED_CALL_STATES = new Set(['ended', 'idle']);

let isWatching = false;

/** Проверить, есть ли новая сборка; `undefined` — сервер не ответил. */
export async function checkAppUpdate() {
  try {
    const response = await fetch(`${VERSION_URL}?${Date.now()}`);
    const version = (await response.text()).trim();
    writeValue(CHECKED_KEY, String(Date.now()));
    const isNew = BUILD_ID_RE.test(version) && version !== APP_BUILD;
    if (isNew) getActions().checkAppVersion();
    return isNew;
  } catch {
    return undefined;
  }
}

export function getUpdateCheckedAt() {
  const value = Number(readValue(CHECKED_KEY));
  return value > 0 ? value : undefined;
}

export function getIsAutoUpdateOn() {
  return readValue(AUTO_KEY) !== '0';
}

export function setAutoUpdateOn(isOn: boolean) {
  writeValue(AUTO_KEY, isOn ? '1' : '0');
}

export function applyAppUpdate() {
  window.location.reload();
}

/** При запуске: ставить найденную новую сборку, когда приложение ушло в фон. */
export function startAutoUpdate() {
  if (isWatching) return;
  isWatching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !getIsAutoUpdateOn()) return;
    if (!getGlobal().isAppUpdateAvailable || getIsCallActive()) return;
    applyAppUpdate();
  });
}

function getIsCallActive() {
  const call = (window as unknown as { parvaneCall?: { state?: string } }).parvaneCall;
  return Boolean(call?.state && !ENDED_CALL_STATES.has(call.state));
}

function readValue(key: string) {
  try {
    return localStorage.getItem(key) || undefined;
  } catch {
    return undefined;
  }
}

function writeValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Настройка действует до перезагрузки
  }
}
