// Настройки списка заметок на этом устройстве: свёрнутые папки и «справку уже показывали»

const COLLAPSED_KEY = 'parvane:knowledge-collapsed';
const GUIDE_SEEN_KEY = 'parvane:knowledge-guide-seen';
const COLLAPSED_MAX = 200;

function read(key: string) {
  try {
    return localStorage.getItem(key) || undefined;
  } catch (err) {
    return undefined;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Хранилище недоступно (закрытый режим) — настройка живёт до перезагрузки
  }
}

/** Ключи свёрнутых групп списка (пути папок). */
export function readCollapsedFolders(): string[] {
  try {
    const value: unknown = JSON.parse(read(COLLAPSED_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch (err) {
    return [];
  }
}

export function writeCollapsedFolders(keys: string[]) {
  write(COLLAPSED_KEY, JSON.stringify(keys.slice(0, COLLAPSED_MAX)));
}

/** Сообщение о появившейся справке на этом устройстве уже показано (либо справку открывали). */
export function isGuideSeen(userId?: string) {
  return read(`${GUIDE_SEEN_KEY}:${userId || ''}`) === '1';
}

export function markGuideSeen(userId?: string) {
  write(`${GUIDE_SEEN_KEY}:${userId || ''}`, '1');
}
