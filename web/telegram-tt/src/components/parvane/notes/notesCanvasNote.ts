// Parvane, раздел «Знания»: карточка заметки на холсте — что делает нажатие по ней, правила названия,
// клавиши поля правки, начало текста для показа. Чистые функции, без UI.

import type {
  CanvasDoc, CanvasNode, CanvasPoint, CanvasSide,
} from './notesCanvas';

import { CANVAS_SIDE_NORMALS, snapTo } from './notesCanvasEdit';
import { noteTitleOfPath } from './notesCanvasFiles';
import { GRAPH_NOTE_FIELD, renameCanvasNote } from './notesCanvasGraph';

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

// Место карточки у конца стрелки, брошенной в точке `point`: карточка встаёт за точкой по ходу стрелки —
// стороной, противоположной стороне начала, к точке (стрелка вправо — левый край карточки у точки)
export function droppedCardPlace(
  point: CanvasPoint, side: CanvasSide, width: number, height: number, grid: number,
): CanvasPoint {
  const normal = CANVAS_SIDE_NORMALS[side];
  return {
    x: snapTo(point.x - width / 2 + (normal.x * width) / 2, grid),
    y: snapTo(point.y - height / 2 + (normal.y * height) / 2, grid),
  };
}

// Заметку `fromId` (название `fromTitle`) удалили, её текст лёг в новую заметку `toId` под названием
// `toTitle`: карточки прежней заметки — по идентификатору и по названию в пути — указывают на новую.
// Нечего менять — прежний документ
export function relinkNoteCards(
  doc: CanvasDoc, fromId: string, fromTitle: string, toId: string, toTitle: string,
): CanvasDoc {
  const fromKey = fromTitle.trim().toLowerCase();
  const isCard = (node: CanvasNode) => node.type === 'file' && (
    node[GRAPH_NOTE_FIELD] === fromId || (noteTitleOfPath(node.file) || '').trim().toLowerCase() === fromKey
  );
  const cards = new Set(doc.nodes.filter(isCard).map(({ id }) => id));
  if (!cards.size) return doc;
  const renamed = renameCanvasNote(doc, fromTitle, toTitle);
  return {
    ...renamed,
    nodes: renamed.nodes.map((node) => (cards.has(node.id) ? { ...node, [GRAPH_NOTE_FIELD]: toId } : node)),
  };
}
