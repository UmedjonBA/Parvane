import { getGlobal } from '../../../global';

import type { ApiArticleMedia } from '../../../api/types';
import type { LangFn } from '../../../util/localization/types';

import { embedNames, renameEmbeds } from '../markdown/markdown';
import { parseNote } from '../notes/notesModel';
import {
  createNote, findNoteByTitle, loadNotes, saveChatFilesToVault,
} from '../notes/notesStore';
import { findMedia } from './articleMedia';

type ArticleSource = {
  title: string;
  markdown: string;
  media?: ApiArticleMedia[];
};

/** Копия статьи из чата — в «Заметки» (ARTICLE-1). Возвращает название сохранённой заметки. */
export async function saveArticleToNotes({ title, markdown, media }: ArticleSource, lang: LangFn) {
  // Хранилище читается раньше записи: без дерева облака папка «Знаний» создалась бы второй раз
  await loadNotes(getGlobal().currentUserId);
  let body = parseNote(markdown).body.trim();
  // Встроенные файлы статьи ложатся в хранилище рядом с заметкой; занятые имена получают номер
  const files = embedNames(body)
    .map((name) => ({ name, item: findMedia(media, name) }))
    .filter(({ item }) => item);
  if (files.length) {
    const renamed = await saveChatFilesToVault(lang('KnowledgeVaultName'), files.map(({ item }) => ({
      fileId: item!.fileId, name: item!.name, mime: item!.mimeType, size: item!.size,
    })));
    if (!renamed) return undefined;
    const targets = files.map(({ name, item }) => [name, renamed.get(item!.name) || item!.name] as const);
    body = renameEmbeds(body, new Map(targets));
  }
  const id = await createNote(title, lang('KnowledgeVaultName'), { text: `# ${title}\n\n${body}\n` });
  if (!id) return undefined;
  const saved = findNoteByTitle(title);
  return saved?.id === id ? saved.title : title;
}
