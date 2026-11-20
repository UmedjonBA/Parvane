import { getActions } from '../../../global';

import type { ApiAttachment } from '../../../api/types';
import type { SharedPayload } from '../../../util/shareTarget';
import { MAIN_THREAD_ID } from '../../../api/types';

import { buildShareNoteText, buildShareNoteTitle } from '../../../util/shareTarget';
import { callApi } from '../../../api/gramjs';
import buildAttachment from '../../middle/composer/helpers/buildAttachment';
import {
  getCloudData, getNodes, loadCloud, refreshCloud, uploadCloudFilesTo, waitForCloudDrive,
} from '../cloud/cloudStore';
import { createNote, getNotes, loadNotes, saveNote } from '../notes/notesStore';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Личный диск в запросах провайдера; у нового аккаунта его ещё нет — первая запись его создаёт
const ROOT_CONTAINER = 'root';

/**
 * «В чат» с экрана «Поделиться» (доска `ZpSysGen`): текст и файлы уходят в каждый выбранный чат сразу —
 * подпись и полученный текст одним сообщением с файлами (подписью к ним) либо отдельно, если файлов нет.
 */
export async function sendSharedToChats(chatIds: string[], text: string, files: File[]) {
  const { sendMessage } = getActions();
  for (const chatId of chatIds) {
    // Вложения — свои у каждого чата: отправка освобождает адреса файлов
    const attachments: ApiAttachment[] = await Promise.all(files.map((file) => buildAttachment(file.name, file)));
    sendMessage({
      messageList: { chatId, threadId: MAIN_THREAD_ID, type: 'thread' },
      text: text || undefined,
      attachments: attachments.length ? attachments : undefined,
      shouldGroupMessages: true,
    });
  }
}

/** «В „Файлы“»: файлы — в папку `folderName` в корне «Моего диска» (создаётся, если её нет). */
export async function saveSharedToFiles(files: File[], folderName: string, userId?: string) {
  await loadCloud(userId);
  // Экран «Поделиться» открывается сразу после запуска: корень диска правится только после его сверки
  if (!await waitForCloudDrive()) return false;
  const folder = await ensureRootFolder(folderName);
  if (!folder) return false;
  const names = await uploadCloudFilesTo(getCloudData()?.rootId || ROOT_CONTAINER, folder, files);
  return names.every(Boolean);
}

/**
 * «В заметку»: новая заметка с полученным текстом; файлы — в облако рядом с ней и в текст вложениями `![[имя]]`.
 * Возвращает название заметки либо `undefined`.
 */
export async function saveSharedToNote(
  shared: SharedPayload, text: string, vaultName: string, fallbackTitle: string, userId?: string,
) {
  await loadNotes(userId);
  const title = buildShareNoteTitle({ ...shared, fileNames: shared.files.map((file) => file.name) }) || fallbackTitle;
  const noteId = await createNote(title, vaultName, { text: buildShareNoteText(title, text, []) });
  if (!noteId) return undefined;
  // Занятое название получает номер — открывать заметку по её настоящему названию
  const savedTitle = getNotes().find(({ id }) => id === noteId)?.title || title;
  if (!shared.files.length) return savedTitle;
  const rootId = getCloudData()?.rootId;
  const parent = getNodes(rootId).find((node) => node.id === noteId)?.parent || undefined;
  const uploaded = await uploadCloudFilesTo(rootId || ROOT_CONTAINER, parent, shared.files);
  const names = uploaded.filter((name): name is string => Boolean(name));
  const isSaved = await saveNote(noteId, buildShareNoteText(title, text, names), vaultName);
  return isSaved && names.length === shared.files.length ? savedTitle : undefined;
}

function newNodeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Новый аккаунт: личный диск создаёт первая запись, и её может прямо сейчас делать другой раздел (папка заметок) —
// отказ повторяется один раз по свежему дереву
async function ensureRootFolder(name: string, isRetry?: boolean): Promise<string | undefined> {
  const findFolder = () => getNodes(getCloudData()?.rootId).find((node) => (
    node.kind === 'folder' && !node.parent && !node.trashed && node.name === name
  ));
  const existing = findFolder();
  if (existing) return existing.id;
  const id = newNodeId();
  const result = await callParvane('parvaneCloudApply', {
    container: ROOT_CONTAINER, ops: [{ op: 'create', id, kind: 'folder', name }],
  }).catch(() => undefined) as { ok: boolean } | undefined;
  await refreshCloud();
  if (!result?.ok) return isRetry ? undefined : ensureRootFolder(name, true);
  return findFolder()?.id || id;
}
