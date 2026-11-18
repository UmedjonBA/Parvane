// Parvane, «Заметки»: «Связи» заметки одним списком — на кого она ссылается, кто ссылается на неё, записи
// «Плана» со ссылкой сюда. Чистая функция для карточек «Связей» и панели графа.

import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';

import { removeLinkFromText } from './notesLinkEdit';

// `out` — заметка упомянута в тексте, `in` — ссылается сюда, `both` — и то и другое, `record` — запись «Плана»
export type NoteLinkWay = 'out' | 'in' | 'both' | 'record';

export type NoteLinkItem = {
  key: string;
  way: NoteLinkWay;
  title: string;
  // У заметки: папка и признак заметки дня — по ним цвет и подпись
  noteId?: string;
  folder?: string;
  isDaily?: boolean;
  // Ссылка отсюда стоит отдельной строкой: связь можно убрать, не трогая прозу
  isRemovable?: boolean;
  recordKind?: PlannedItem['kind'];
};

/** Связи заметки: сначала те, на кого она ссылается (в порядке текста), затем ссылающиеся сюда, затем записи. */
export function listNoteLinks(noteId: string, index: NotesIndex, planned: PlannedItem[]): NoteLinkItem[] {
  const note = index.byId(noteId);
  if (!note) return [];
  const items = new Map<string, NoteLinkItem>();
  note.linkedIds.forEach((id) => {
    const other = index.byId(id);
    if (!other || other.id === noteId) return;
    items.set(other.id, {
      key: other.id,
      way: 'out',
      title: other.title,
      noteId: other.id,
      folder: other.folder,
      isRemovable: removeLinkFromText(note.text, other.title).status === 'removed',
    });
  });
  index.backlinks(noteId).forEach((other) => {
    const known = items.get(other.id);
    if (known) known.way = 'both';
    else {
      items.set(other.id, {
        key: other.id, way: 'in', title: other.title, noteId: other.id, folder: other.folder,
      });
    }
  });
  planned.forEach((item) => {
    if (items.has(item.key)) return;
    items.set(item.key, {
      key: item.key, way: 'record', title: item.name, recordKind: item.kind,
    });
  });
  return [...items.values()];
}
