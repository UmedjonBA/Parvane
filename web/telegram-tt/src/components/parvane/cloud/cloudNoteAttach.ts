import type { CloudNode } from './cloudModel';

import { drivePathOf } from '../notes/notesCanvasFiles';
import { resolveEmbed } from '../notes/notesEmbeds';

// Parvane (spec 041 E2, доска `ZdFilesX`): «Вложить в заметку…» — файл «Файлов» встаёт в конец заметки
// вложением `![[…]]`. Файл личного диска не копируется: в тексте — его имя, если по имени находится именно он
// (как в Obsidian: сначала рядом с заметкой, потом ближе к корню), иначе путь от корня диска. Файл чужой либо
// общей папки сперва копируется рядом с заметкой (заметки видят только личный диск)

/** Что писать в `![[…]]` для файла личного диска. */
export function embedTargetOf(driveNodes: CloudNode[], file: CloudNode, noteId: string) {
  return resolveEmbed(driveNodes, file.name, noteId)?.id === file.id ? file.name : drivePathOf(driveNodes, file.id);
}

/** Текст заметки со вложением в конце отдельным абзацем. */
export function appendEmbed(text: string, target: string) {
  const body = text.replace(/\s+$/, '');
  return `${body}${body ? '\n\n' : ''}![[${target}]]\n`;
}
