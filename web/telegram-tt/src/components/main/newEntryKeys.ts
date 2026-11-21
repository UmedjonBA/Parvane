import type { ParvaneModuleId } from '../../util/parvaneModules';

// Parvane (доски `ZdNav`, `DeskOverlays`): Ctrl+N — новое в открытом модуле. Чистые проверки — отдельно от
// слушателя, чтобы их можно было проверить тестом

type NewEntryKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
  & { isComposing?: boolean };

// Что делает Ctrl+N: «Чаты» — новое сообщение, «Заметки» — новая заметка, «План» — его окно ввода, остальные
// модули — окно «Новая запись» поверх себя
export type NewEntryAction = 'message' | 'note' | 'plan' | 'inPlace';

/** Ctrl+N (Cmd+N); `code` — чтобы сочетание работало и в русской раскладке. */
export function isNewEntryHotkey(e: NewEntryKeyEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return false;
  return e.code === 'KeyN' || e.key.toLowerCase() === 'n';
}

export function selectNewEntryAction(module: ParvaneModuleId): NewEntryAction {
  if (module === 'chats') return 'message';
  if (module === 'notes') return 'note';
  if (module === 'plan') return 'plan';
  return 'inPlace';
}
