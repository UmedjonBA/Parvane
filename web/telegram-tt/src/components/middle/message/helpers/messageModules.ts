import { getGlobal } from '../../../../global';

import type { LangFn } from '../../../../util/localization/types';
import type { NoteEntry } from '../../../parvane/notes/notesStore';

import { requestPlannerAddText } from '../../../../util/parvaneSection';
import { createSignal } from '../../../../util/signals';
import {
  createNote, findNoteByTitle, loadNotes, saveNote,
} from '../../../parvane/notes/notesStore';

const NOTE_TITLE_MAX_LENGTH = 60;
const PLAN_LINE_MAX_LENGTH = 200;

// «В заметку» (доска `ZpChat`: «новая или в существующую»): меню сообщения оставляет запрос, выбор заметки живёт в
// `MessageNoteDialog` (смонтирован в `Main`) и не закрывается вместе с меню
const [getMessageNoteRequest, setMessageNoteRequest] = createSignal<string | undefined>(undefined);

export { getMessageNoteRequest };

export function requestMessageToNote(text: string) {
  setMessageNoteRequest(text);
}

export function closeMessageNoteRequest() {
  setMessageNoteRequest(undefined);
}

/** «В план» из меню сообщения: окно ввода «Плана» с текстом сообщения одной строкой. */
export function openMessageInPlan(text: string) {
  requestPlannerAddText(text.replace(/\s+/g, ' ').trim().slice(0, PLAN_LINE_MAX_LENGTH));
}

/** «В заметку» из меню сообщения: новая заметка с текстом сообщения. Возвращает её название. */
export async function saveMessageToNote(text: string, lang: LangFn) {
  const firstLine = text.trim().split('\n')[0].replace(/[\\/:*?"<>|#[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = firstLine.slice(0, NOTE_TITLE_MAX_LENGTH).trim() || lang('MessageNoteTitle');
  // Хранилище читается раньше записи: без дерева облака папка заметок создалась бы второй раз
  await loadNotes(getGlobal().currentUserId);
  const id = await createNote(title, lang('KnowledgeVaultName'), { text: `# ${title}\n\n${text.trim()}\n` });
  if (!id) return undefined;
  const saved = findNoteByTitle(title);
  return saved?.id === id ? saved.title : title;
}

/** «В заметку» в существующую: текст сообщения дописывается в конец заметки отдельным абзацем. */
export function appendMessageToNote(note: NoteEntry, text: string, lang: LangFn) {
  return saveNote(note.id, `${note.text.trimEnd()}\n\n${text.trim()}\n`, lang('KnowledgeVaultName'), note.text);
}
