// Подсказка при наведении (доска `ZdMisc`): через полсекунды — название действия и клавиша. Чьё название и какая
// клавиша — правило здесь, показывает `components/main/PvTooltipHost.tsx`. Подсказку получают кнопки-значки (имя
// только в `aria-label`, своего `title` нет), элементы с `data-pv-tip` и всё, у чего есть `aria-keyshortcuts`

export const TIP_DELAY_MS = 500;

export type PvTip = { text: string; kbd?: string };

const TIP_SELECTOR = '[data-pv-tip], [aria-keyshortcuts], button[aria-label], [role="button"][aria-label]';

/** Ближайший к цели элемент с подсказкой и сама подсказка; у кнопки с видимым текстом без клавиши её нет. */
export function findTip(target: EventTarget | null): { element: HTMLElement; tip: PvTip } | undefined {
  if (!(target instanceof Element)) return undefined;
  const element = target.closest<HTMLElement>(TIP_SELECTOR);
  if (!element || element.hasAttribute('disabled') || element.hasAttribute('title')) return undefined;
  const tip = readTip({
    tip: element.dataset.pvTip,
    label: element.getAttribute('aria-label') || undefined,
    keys: element.getAttribute('aria-keyshortcuts') || undefined,
    text: element.textContent || '',
  });
  return tip ? { element, tip } : undefined;
}

/** Подсказка по полям элемента: своя строка, иначе имя; кнопке с текстом — только если есть клавиша. */
export function readTip({
  tip, label, keys, text,
}: { tip?: string; label?: string; keys?: string; text: string }): PvTip | undefined {
  const kbd = keys ? formatShortcut(keys) : undefined;
  const visibleText = text.trim();
  if (tip) return { text: tip, kbd };
  if (!visibleText && label) return { text: label, kbd };
  if (kbd && (label || visibleText)) return { text: label || visibleText, kbd };
  return undefined;
}

/** `aria-keyshortcuts` («Control+S», «F2», несколько через пробел) → «Ctrl+S»; на Mac — «⌘S». */
export function formatShortcut(keys: string, isMac?: boolean) {
  const first = keys.trim().split(/\s+/)[0];
  if (!first) return undefined;
  return first.split('+').map((part) => {
    if (part === 'Control') return isMac ? '⌘' : 'Ctrl';
    if (part === 'Meta') return '⌘';
    if (part === 'Delete') return 'Del';
    return part.length === 1 ? part.toUpperCase() : part;
  }).join(isMac ? '' : '+');
}
