import type { ApiChat } from '../../../api/types';
import type { NoteEntry } from '../notes/notesStore';

import { callApi } from '../../../api/gramjs';
import { freeName } from '../cloud/cloudModel';
import { getCloudData, getNodes } from '../cloud/cloudStore';
import { embedBaseName, embedNames, renameEmbeds } from '../markdown/markdown';
import { resolveEmbed } from '../notes/notesEmbeds';
import { parseNote } from '../notes/notesModel';

// Заметка статьёй в чат (ARTICLE-1): из меню вложений чата (`ArticlePickerModal`) и из меню заметки
// (`NoteArticleDialog`) — один путь

export type ArticleSendResult = 'sent' | 'too-long' | 'failed';

export const ARTICLE_ERROR_KEYS = {
  'too-long': 'ArticleTooLong',
  failed: 'ArticleSendFailed',
} as const;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// Предел схемы `Article.media`
const ARTICLE_MEDIA_MAX = 32;

export async function sendNoteArticle(chat: ApiChat, note: NoteEntry): Promise<ArticleSendResult> {
  const prepared = await prepareArticle(note);
  if (!prepared) return 'failed';
  const result = await callParvane('parvaneSendArticle', {
    chat, title: note.title, markdown: prepared.markdown, media: prepared.media,
  }).catch(() => undefined);
  if (result === true) return 'sent';
  return result === 'too-long' ? 'too-long' : 'failed';
}

// Текст статьи и её файлы: встроенные файлы облака копируются во вложения; в тексте — имя без папок (два
// разных файла с одним именем различаются номером). Не найденные файлы остаются в тексте как есть
async function prepareArticle(note: NoteEntry) {
  let markdown = parseNote(note.text).body.trim();
  const cloud = getCloudData();
  const driveId = cloud?.rootId;
  const nodes = driveId ? getNodes(driveId, cloud) : [];
  const taken = new Set<string>();
  const byNode = new Map<string, string>();
  const rename = new Map<string, string>();
  const items: { node: string; name: string }[] = [];
  embedNames(markdown).forEach((name) => {
    const node = resolveEmbed(nodes, name, note.id);
    if (!node || (!byNode.has(node.id) && items.length >= ARTICLE_MEDIA_MAX)) return;
    let fileName = byNode.get(node.id);
    if (!fileName) {
      fileName = freeName(taken, embedBaseName(node.name));
      taken.add(fileName);
      byNode.set(node.id, fileName);
      items.push({ node: node.id, name: fileName });
    }
    rename.set(name, fileName);
  });
  if (!items.length) return { markdown, media: undefined };
  markdown = renameEmbeds(markdown, rename);
  const result = await callParvane('parvaneCloudArticleMedia', { container: driveId, items })
    .catch(() => undefined) as { ok: boolean; media?: unknown[] } | undefined;
  return result?.ok ? { markdown, media: result.media } : undefined;
}
