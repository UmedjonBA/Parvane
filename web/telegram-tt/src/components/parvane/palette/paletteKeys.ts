// Parvane: клавиши, открывающие палитру. Чистые проверки события — отдельно от обёртки, чтобы их можно было
// проверить тестом без приложения

type PaletteKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>
  & { isComposing?: boolean };

/** Фокус в месте, где «/» печатается: поле, список, редактируемый текст (в том числе вложенный в него узел). */
export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  // `isContentEditable` есть не везде (jsdom) — запасная проверка по атрибуту предка
  return Boolean(target.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

/** «/» без модификаторов вне поля ввода (как в прототипе); Shift не мешает — в части раскладок «/» идёт с ним. */
export function isPaletteSlashKey(e: PaletteKeyEvent) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  return !isEditableTarget(e.target);
}

/** Ctrl+K (Cmd+K); `code` — чтобы сочетание работало и в русской раскладке. */
export function isPaletteHotkey(e: PaletteKeyEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  return e.code === 'KeyK' || e.key.toLowerCase() === 'k';
}
