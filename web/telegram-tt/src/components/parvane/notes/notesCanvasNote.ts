// Parvane, раздел «Знания»: карточка заметки на холсте — что делает нажатие по ней, правила названия,
// клавиши поля правки, начало текста для показа. Чистые функции, без UI.

export type NoteCardState = 'found' | 'missing' | 'loading';
// Куда пришлось действие: шапка с названием, текст карточки либо команда («Изменить» панели и меню)
export type NoteCardPart = 'title' | 'body' | 'command';
export type NoteCardAction = 'editBody' | 'editTitle' | 'create' | 'none';
export type CanvasInlineKind = 'node' | 'edge' | 'note' | 'title';
export type CanvasInlineKey = {
  key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean;
};

export const NOTE_TITLE_MAX = 120;

const HEADING_MARK = /^#+\s*/;
const TASK_MARKER = / \^t[a-z0-9]{4,12}\s*$/;
const LIST_MARK = /^\s*[-*+] (\[[ xX]\] )?/;

// Действие с карточкой заметки. Найденная заметка правится на месте: текст — по тексту карточки и по
// команде, название — по шапке (у заметки дня название — дата, оно не меняется). Заметки нет — править
// нечего, команда предлагает её создать. Хранилище ещё читается — ничего: пустое поле затёрло бы заметку
export function noteCardAction(state: NoteCardState, part: NoteCardPart, isDaily = false): NoteCardAction {
  if (state === 'loading') return 'none';
  if (state === 'missing') return part === 'command' ? 'create' : 'none';
  if (part !== 'title') return 'editBody';
  return isDaily ? 'none' : 'editTitle';
}

// Новое название из поля: без пробелов по краям. Пустое и прежнее — отказ (`undefined`), название остаётся.
// Занятое название получает номер уже при переименовании
export function nextNoteTitle(value: string, current: string) {
  const next = value.trim();
  return next && next !== current ? next : undefined;
}

// Клавиша в поле правки на месте. Escape отменяет. Enter сохраняет однострочное и текст карточки (там
// новая строка — Shift+Enter); в тексте заметки Enter — новая строка, сохраняет Ctrl/Cmd+Enter
export function inlineKeyAction(kind: CanvasInlineKind, e: CanvasInlineKey): 'save' | 'cancel' | undefined {
  if (e.key === 'Escape') return 'cancel';
  if (e.key !== 'Enter' || e.isComposing) return undefined;
  if (kind === 'note') return e.ctrlKey || e.metaKey ? 'save' : undefined;
  return e.shiftKey ? undefined : 'save';
}

// Начало текста заметки для карточки, без разметки: заголовок с названием и метки пунктов не показываются,
// пункты списка идут с точкой. `body` — текст заметки без блока свойств
export function notePreviewLines(body: string, title: string, max: number) {
  const ownTitle = title.trim().toLowerCase();
  return body.split('\n')
    .map((line) => line.replace(HEADING_MARK, '').replace(TASK_MARKER, '').replace(LIST_MARK, '• '))
    .filter((line) => line.trim() && line.trim().toLowerCase() !== ownTitle)
    .slice(0, max);
}
