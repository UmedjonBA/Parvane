// «Автозагрузка медиа» в «Данных и памяти» (доска `DkSettingsB`): всегда, только по Wi-Fi либо никогда. Настройка
// устройства поверх прежних выключателей по типам чатов. «Только Wi-Fi» опирается на Network Information API: тип
// связи сообщает не каждый браузер (Chromium на Android — да, на компьютере — нет); неизвестный тип считается не
// мобильной связью — иначе на компьютере медиа не грузились бы никогда
export type AutoloadMode = 'always' | 'wifi' | 'never';

export const AUTOLOAD_MODES: AutoloadMode[] = ['always', 'wifi', 'never'];

const STORAGE_KEY = 'parvane:autoload';
const METERED_TYPES = new Set(['cellular', 'wimax', 'bluetooth']);

let cached: AutoloadMode | undefined;

export function getAutoloadMode(): AutoloadMode {
  if (cached) return cached;
  try {
    const value = localStorage.getItem(STORAGE_KEY) as AutoloadMode | null;
    cached = value && AUTOLOAD_MODES.includes(value) ? value : 'always';
  } catch {
    cached = 'always';
  }
  return cached;
}

export function setAutoloadMode(mode: AutoloadMode) {
  cached = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Настройка действует до перезагрузки
  }
}

/** Можно ли сейчас загружать медиа сами по себе. */
export function getIsAutoloadAllowed(mode: AutoloadMode, connectionType?: string) {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return !connectionType || !METERED_TYPES.has(connectionType);
}

export function getIsAutoloadAllowedNow() {
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return getIsAutoloadAllowed(getAutoloadMode(), connection?.type);
}
