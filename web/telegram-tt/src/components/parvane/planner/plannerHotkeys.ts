// Parvane (доска `ZdNav`, «Горячие клавиши» → «План»): N — новая запись, T — сегодня, ← → — период назад и вперёд,
// Пробел — отметить задачу под фокусом выполненной. Без модификаторов и не в поле ввода; `code` — любая раскладка

type PlannerKeyEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export type PlannerHotkey = 'new' | 'today' | 'prev' | 'next' | 'done';

const KEYS: Record<string, PlannerHotkey> = {
  KeyN: 'new',
  KeyT: 'today',
  ArrowLeft: 'prev',
  ArrowRight: 'next',
  Space: 'done',
};

export function matchPlannerHotkey(e: PlannerKeyEvent, isEditable: boolean): PlannerHotkey | undefined {
  if (isEditable || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return undefined;
  return KEYS[e.code];
}
