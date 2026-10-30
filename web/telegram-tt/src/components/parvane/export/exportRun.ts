// «Выгрузка данных»: сборка архива целиком на устройстве. Источник данных (`ExportSource`) подставляется:
// в приложении — методы провайдера (`exportSource.ts`), в тестах — подделка. Порядок: чаты (сначала их
// вложения, затем `messages.json`/`messages.html` — статусы вложений уже известны), «План», заметки,
// контакты, по желанию — файлы облака, в конце `index.html`. Отмена — `AbortSignal`: между файлами и
// внутри потока файла; при отмене или ошибке накопленное выбрасывается.

import type { CloudNodeJson } from '../../../api/parvane/cloudDrive';
import type { ExportChat, ExportContact, ExportIndexSections, ExportLabels, ExportSnapshot } from './exportModel';

import { isServiceNode } from '../cloud/cloudModel';
import {
  assignChatDirs, exportArchiveName, renderChatHtml, renderChatJson, renderIndexHtml, sanitizeFileName, uniqueName,
} from './exportModel';
import { createZipWriter, ExportError, throwIfAborted } from './exportZip';

// Глубже папки не обходим (как kExportMaxDepth в desktop)
const EXPORT_MAX_DEPTH = 64;

export type ExportOptions = { includeMedia: boolean; includeCloud: boolean };

export type ExportStage = 'prepare' | 'chats' | 'planner' | 'notes' | 'contacts' | 'cloud' | 'finishing';

export type ExportProgress = {
  stage: ExportStage;
  /** Готово шагов этапа и всего (чаты: вложения + сами чаты; облако: файлы). */
  done: number;
  total: number;
  /** Записано байт архива. */
  bytes: number;
};

/** Файл облака к выгрузке: где лежит в облаке и куда ляжет в архиве (`cloud/…`). */
export type ExportCloudFile = {
  container: string;
  node: string;
  path: string;
  size: number;
  mtime?: number;
};

export type ExportNote = { path: string; text: string; mtime?: number };

export type ExportSource = {
  snapshot: () => Promise<ExportSnapshot | undefined>;
  /** Расшифрованное вложение сообщения; `undefined` — недоступно. */
  media: (fileId: string, signal: AbortSignal) => Promise<Blob | undefined>;
  /** Состояние «Плана» (JSON-текст); `undefined` — нет данных. */
  planner: () => Promise<string | undefined>;
  /** Заметки «Знаний» с путями внутри `notes/`. */
  notes: () => Promise<ExportNote[]>;
  cloudFiles: () => Promise<ExportCloudFile[]>;
  cloudBlob: (file: ExportCloudFile, signal: AbortSignal) => Promise<Blob | undefined>;
};

export type ExportResult = {
  blob: Blob;
  fileName: string;
  chats: number;
  messages: number;
  media: number;
  mediaFailed: number;
  notes: number;
  cloudFiles: number;
  cloudFailed: number;
};

// Порядок по кодам символов: не зависит от языка браузера, архив с одних данных всегда одинаков
function byName(a: CloudNodeJson, b: CloudNodeJson) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Пути файлов дерева облака: папки — каталогами, имена — очищенными и различными в пределах папки.
 * Корзина и служебные файлы пропускаются; `root` — откуда начинать (не задан — корень контейнера).
 */
export function treeFilePaths(
  nodes: CloudNodeJson[], prefix: string, root?: string, accept: (node: CloudNodeJson) => boolean = () => true,
) {
  const out: { node: CloudNodeJson; path: string }[] = [];
  const byParent = new Map<string | undefined, CloudNodeJson[]>();
  nodes.forEach((node) => {
    if (node.trashed || isServiceNode(node)) return;
    const key = node.parent || undefined;
    const list = byParent.get(key);
    if (list) list.push(node);
    else byParent.set(key, [node]);
  });
  const seen = new Set<string>();
  const walk = (parent: string | undefined, dir: string, depth: number) => {
    // Глубже предела не спускаемся (дерево совместной папки задаёт любой её редактор), как kExportMaxDepth в desktop
    if (depth > EXPORT_MAX_DEPTH) return;
    const taken = new Set<string>();
    const children = (byParent.get(parent) || []).slice().sort(byName);
    children.forEach((node) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      const name = uniqueName(taken, sanitizeFileName(node.name, node.kind));
      if (node.kind === 'folder') walk(node.id, `${dir}${name}/`, depth + 1);
      else if (node.blob && accept(node)) out.push({ node, path: `${dir}${name}` });
    });
  };
  walk(root, prefix, 0);
  return out;
}

/** Файлы облака по контейнерам: каждый контейнер — своя папка `cloud/<название>/`. */
export function cloudExportFiles(trees: { id: string; name: string; nodes: CloudNodeJson[] }[], fallbackName: string) {
  const taken = new Set<string>();
  return trees.flatMap((tree) => {
    const dir = uniqueName(taken, sanitizeFileName(tree.name, fallbackName));
    return treeFilePaths(tree.nodes, `cloud/${dir}/`).map(({ node, path }): ExportCloudFile => ({
      container: tree.id, node: node.id, path, size: node.blob?.size ?? node.size, mtime: node.mtime || undefined,
    }));
  });
}

function toExportError(e: unknown, signal: AbortSignal) {
  if (e instanceof ExportError) return e;
  if (signal.aborted) return new ExportError('canceled');
  return new ExportError('failed', e instanceof Error ? e.message : String(e));
}

function contactsJson(contacts: ExportContact[]) {
  return JSON.stringify({
    contacts: contacts.map((c) => ({ name: c.name, address: c.address, ...(c.isExplicit ? { added: true } : {}) })),
  }, undefined, 2);
}

function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), undefined, 2);
  } catch {
    return text;
  }
}

export async function runDataExport(args: {
  source: ExportSource;
  options: ExportOptions;
  labels: ExportLabels;
  signal: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  now?: Date;
}): Promise<ExportResult> {
  const {
    source, options, labels, signal, onProgress,
  } = args;
  const now = args.now || new Date();
  let progress: ExportProgress = {
    stage: 'prepare', done: 0, total: 0, bytes: 0,
  };
  const report = (patch: Partial<ExportProgress>) => {
    progress = { ...progress, ...patch };
    onProgress?.(progress);
  };
  const writer = createZipWriter({
    signal,
    onBytes: (bytes) => {
      progress.bytes = bytes;
    },
  });
  const result = {
    chats: 0, messages: 0, media: 0, mediaFailed: 0, notes: 0, cloudFiles: 0, cloudFailed: 0,
  };
  try {
    report({ stage: 'prepare' });
    const snapshot = await source.snapshot();
    throwIfAborted(signal);
    if (!snapshot) throw new ExportError('failed', 'no snapshot');
    const chats: ExportChat[] = assignChatDirs(snapshot.chats, labels, options.includeMedia);
    const mediaTotal = chats.reduce(
      (sum, chat) => sum + chat.messages.filter((m) => m.media?.status === 'included').length, 0,
    );
    let chatSteps = 0;
    report({ stage: 'chats', done: 0, total: mediaTotal + chats.length });
    for (const chat of chats) {
      for (const message of chat.messages) {
        const { media } = message;
        if (media?.status !== 'included') continue;
        throwIfAborted(signal);
        const blob = await source.media(media.fileId, signal).catch(() => undefined);
        throwIfAborted(signal);
        if (blob) {
          await writer.addBlob(`${chat.dir}/${media.path}`, blob, new Date(message.ts * 1000));
          result.media++;
        } else {
          media.status = 'unavailable';
          result.mediaFailed++;
        }
        report({ done: ++chatSteps });
      }
      await writer.addText(`${chat.dir}/messages.json`, renderChatJson(chat));
      await writer.addText(`${chat.dir}/messages.html`, renderChatHtml(chat, labels));
      result.chats++;
      result.messages += chat.messages.length;
      report({ done: ++chatSteps });
    }

    const sections: ExportIndexSections = {};
    report({ stage: 'planner', done: 0, total: 1 });
    const planner = await source.planner().catch(() => undefined);
    throwIfAborted(signal);
    if (planner) {
      sections.planner = 'planner/planner.json';
      await writer.addText(sections.planner, prettyJson(planner));
    }
    report({ done: 1 });

    report({ stage: 'notes', done: 0, total: 1 });
    const notes = await source.notes().catch(() => []);
    throwIfAborted(signal);
    if (notes.length) {
      sections.notes = [];
      report({ total: notes.length });
      for (const note of notes) {
        const path = `notes/${note.path}`;
        await writer.addText(path, note.text, note.mtime ? new Date(note.mtime) : undefined);
        sections.notes.push(path);
        result.notes++;
        report({ done: result.notes });
      }
    }

    report({ stage: 'contacts', done: 0, total: 1 });
    sections.contacts = 'contacts.json';
    await writer.addText(sections.contacts, contactsJson(snapshot.contacts));
    report({ done: 1 });

    if (options.includeCloud) {
      report({ stage: 'cloud', done: 0, total: 0 });
      const files = await source.cloudFiles();
      throwIfAborted(signal);
      sections.cloud = [];
      report({ total: files.length });
      let done = 0;
      for (const file of files) {
        throwIfAborted(signal);
        const blob = await source.cloudBlob(file, signal).catch((e: unknown) => {
          if (signal.aborted) throw new ExportError('canceled');
          if (e instanceof ExportError) throw e;
          return undefined;
        });
        throwIfAborted(signal);
        if (blob) {
          await writer.addBlob(file.path, blob, file.mtime ? new Date(file.mtime) : undefined);
          sections.cloud.push(file.path);
          result.cloudFiles++;
        } else {
          result.cloudFailed++;
        }
        report({ done: ++done });
      }
    }

    report({ stage: 'finishing', done: 0, total: 1 });
    await writer.addText('index.html', renderIndexHtml(
      { address: snapshot.self, name: snapshot.selfName }, chats, sections, labels, now,
    ));
    const blob = await writer.finish();
    report({ done: 1, bytes: blob.size });
    return { blob, fileName: exportArchiveName(snapshot.self, now), ...result };
  } catch (e) {
    writer.abort();
    throw toExportError(e, signal);
  }
}
