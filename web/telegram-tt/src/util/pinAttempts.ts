// PIN хранилища (spec 041 E6, доска `ZpSystem`): четыре цифры и пять неверных вводов подряд — после пятого
// устройство выходит из аккаунта. Счётчик лежит в localStorage: перезагрузка страницы его не обнуляет
export const PIN_LENGTH = 4;
export const PIN_MAX_ATTEMPTS = 5;

// Ключ кончается адресом: выход из аккаунта стирает его вместе с прочими `parvane:…:<адрес>` (WEB-10)
const STORAGE_PREFIX = 'parvane:pin-fails:';

// Запасной счётчик вкладки — когда localStorage недоступен (приватный режим)
const memoryCounts = new Map<string, number>();

export function isPinComplete(pin: string) {
  return pin.length === PIN_LENGTH && /^\d+$/.test(pin);
}

export function readPinAttemptsLeft(user: string) {
  return PIN_MAX_ATTEMPTS - readCount(user);
}

// Попытка записывается ДО проверки PIN: перезагрузка посреди проверки её не возвращает. Ответ — сколько осталось
export function registerPinAttempt(user: string) {
  const count = Math.min(readCount(user) + 1, PIN_MAX_ATTEMPTS);
  memoryCounts.set(user, count);
  try {
    localStorage.setItem(STORAGE_PREFIX + user, String(count));
  } catch {
    // Счётчик остаётся в памяти вкладки
  }
  return PIN_MAX_ATTEMPTS - count;
}

export function resetPinAttempts(user: string) {
  memoryCounts.delete(user);
  try {
    localStorage.removeItem(STORAGE_PREFIX + user);
  } catch {
    // Нечего стирать
  }
}

function readCount(user: string) {
  const stored = Number(readStored(user));
  // Испорченная запись не даёт новых попыток: считается исчерпанной
  const persisted = Number.isInteger(stored) && stored >= 0 ? stored : PIN_MAX_ATTEMPTS;
  return Math.min(Math.max(persisted, memoryCounts.get(user) || 0), PIN_MAX_ATTEMPTS);
}

function readStored(user: string) {
  try {
    return localStorage.getItem(STORAGE_PREFIX + user) || '0';
  } catch {
    return '0';
  }
}
