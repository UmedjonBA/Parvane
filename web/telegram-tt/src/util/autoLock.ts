import { createSignal } from './signals';

// Parvane (spec 041, доска `ZdProfileX`, «Защита приложения»): автоблокировка после N минут без действий и
// «Блокировать сейчас» (Ctrl+L / ⌘L). Блокировка — перезагрузка вкладки: ключ хранилища живёт только в памяти, и
// запуск снова спрашивает PIN (`pinGate.ts`). Без PIN блокировать нечем — Ctrl+L остаётся браузеру.
// Срок — настройка устройства для аккаунта (`parvane:autolock-minutes`, стирается вместе с аккаунтом)

const STORAGE_KEY = 'parvane:autolock-minutes';
// Только диагностическая сборка (сценарии): срок в миллисекундах вместо минут
const E2E_MS_KEY = 'parvane:e2e:autolockMs';
const ARE_DIAG_HOOKS_ENABLED = import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1';
export const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 60] as const;
export const DEFAULT_AUTO_LOCK_MINUTES = 5;
const MINUTE_MS = 60_000;

const [getAutoLockMinutes, setMinutesSignal] = createSignal(readStored());

export { getAutoLockMinutes };

export function setAutoLockMinutes(minutes: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(minutes));
  } catch {
    // Срок останется до перезагрузки
  }
  setMinutesSignal(minutes);
}

/** Пора ли блокировать: прошло не меньше срока с последнего действия (0 — автоблокировка выключена). */
export function getIsAutoLockDue(lastActivityAt: number, now: number, minutes = getAutoLockMinutes()) {
  const testMs = readTestMs();
  if (testMs) return now - lastActivityAt >= testMs;
  return minutes > 0 && now - lastActivityAt >= minutes * MINUTE_MS;
}

/** Сочетание «Блокировать сейчас»: Ctrl+L (⌘L на Mac) без Shift и Alt. */
export function getIsLockHotkey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
) {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.code === 'KeyL' || e.key.toLowerCase() === 'l');
}

export function lockAppNow() {
  window.location.reload();
}

function readTestMs() {
  if (!ARE_DIAG_HOOKS_ENABLED) return 0;
  try {
    return Number(localStorage.getItem(E2E_MS_KEY)) || 0;
  } catch {
    return 0;
  }
}

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY) ?? undefined;
    if (value === undefined) return DEFAULT_AUTO_LOCK_MINUTES;
    const minutes = Number(value);
    return (AUTO_LOCK_CHOICES as readonly number[]).includes(minutes) ? minutes : DEFAULT_AUTO_LOCK_MINUTES;
  } catch {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
}
