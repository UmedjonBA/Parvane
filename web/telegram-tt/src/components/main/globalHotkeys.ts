// Parvane (доска `ZdNav`, «Горячие клавиши»): сочетания «Везде» — чистая часть, разбор нажатия → действие.
// Ctrl на компьютере, ⌘ на macOS; `code` — чтобы сочетания работали в любой раскладке

type HotkeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export type GlobalHotkey =
  | { kind: 'module'; index: number }
  | { kind: 'settings' }
  | { kind: 'help' }
  | { kind: 'music' };

// Модулей в ленте не больше семи: Ctrl+1 … 7
const MAX_MODULE_DIGIT = 7;
const DIGIT_CODE = /^Digit([1-9])$/;

/** Что делает нажатие из любого места приложения; `undefined` — сочетание не наше. */
export function matchGlobalHotkey(e: HotkeyEvent, isMac: boolean): GlobalHotkey | undefined {
  const hasModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!hasModifier || e.altKey) return undefined;
  // Ctrl+/ — и с Shift: в части раскладок «/» набирается с ним («?» на той же клавише)
  if (e.code === 'Slash' || e.key === '/' || e.key === '?') return { kind: 'help' };
  if (e.shiftKey) return undefined;
  const digit = DIGIT_CODE.exec(e.code)?.[1];
  if (digit) {
    const index = Number(digit) - 1;
    return index < MAX_MODULE_DIGIT ? { kind: 'module', index } : undefined;
  }
  if (e.code === 'Comma' || e.key === ',') return { kind: 'settings' };
  if (e.code === 'Space') return { kind: 'music' };
  return undefined;
}

/** Подпись сочетания для экрана: `Ctrl+K` либо `⌘K` на macOS. */
export function formatHotkey(keys: string, isMac: boolean) {
  return isMac ? keys.replace(/Ctrl\+/g, '⌘') : keys;
}
