import { getGlobal } from '../../../../global';

import type { LangFn } from '../../../../util/localization/types';

import { requestPlannerAddText } from '../../../../util/parvaneSection';
import { createNote, findNoteByTitle, loadNotes } from '../../../parvane/notes/notesStore';

const NOTE_TITLE_MAX_LENGTH = 60;
const PLAN_LINE_MAX_LENGTH = 200;

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
