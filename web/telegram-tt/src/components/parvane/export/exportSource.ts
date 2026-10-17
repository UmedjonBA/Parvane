// «Выгрузка данных»: источник данных архива — методы провайдера (всё на устройстве: кэш истории, движок
// «Плана», дерево облака и расшифровка блобов). Нового на сервере нет: файлы облака и вложения качаются тем
// же путём, что и при просмотре.

import type { CloudDriveState } from '../../../api/parvane/cloudDrive';
import type { ExportSnapshot } from './exportModel';
import type { ExportCloudFile, ExportNote, ExportSource } from './exportRun';

import { callApi } from '../../../api/gramjs';
import { cloudExportFiles, treeFilePaths } from './exportRun';
import { ExportError } from './exportZip';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Заметки — `.md` (и холсты `.canvas`) в папке «Знания» в корне личного диска (`notesStore.ts`)
const VAULT_NAMES = ['Знания', 'Knowledge'];
const NOTE_FILE = /\.(md|canvas)$/i;
const READ_TEXTS_BATCH = 40;
// Движок «Плана» и облака поднимается при первом обращении — столько ждём готовности
const READY_WAIT_MS = 30000;
const READY_POLL_MS = 500;

// Только диаг-сборка (e2e): задержка перед сбором снимка — сценарий успевает нажать «Отмена»
const ARE_DIAG_HOOKS_ENABLED = import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1';
const E2E_DELAY_STORAGE_KEY = 'parvane:e2e:exportDelayMs';
const E2E_DELAY_MAX_MS = 30000;

function e2eDelayMs() {
  if (!ARE_DIAG_HOOKS_ENABLED) return 0;
  try {
    return Math.min(E2E_DELAY_MAX_MS, Math.max(0, Number(localStorage.getItem(E2E_DELAY_STORAGE_KEY)) || 0));
  } catch {
    return 0;
  }
}

type PlannerReply = { status?: string; raw?: string };
type TextReply = { id: string; text?: string };

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, isReady: (value: T) => boolean): Promise<T | undefined> {
  const deadline = Date.now() + READY_WAIT_MS;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read().catch(() => undefined);
    if (last !== undefined && isReady(last)) return last;
    await sleep(READY_POLL_MS);
  }
  return last;
}

export function createProviderSource(names: { drive: string }): ExportSource {
  let cloudPromise: Promise<CloudDriveState | undefined> | undefined;

  // Состояние облака: первый вызов запускает подключение, ждём `ready` (без ключа/связи — что есть)
  function cloudState() {
    cloudPromise ||= waitFor(
      () => callParvane('parvaneCloudState') as Promise<CloudDriveState | undefined>,
      (state) => state.status !== 'loading',
    );
    return cloudPromise;
  }

  async function notes(): Promise<ExportNote[]> {
    const state = await cloudState();
    const rootId = state?.rootId;
    const tree = rootId ? state?.trees[rootId] : undefined;
    if (!rootId || !tree) return [];
    const vault = tree.nodes.find((node) => (
      node.kind === 'folder' && !node.parent && !node.trashed && VAULT_NAMES.includes(node.name)
    ));
    if (!vault) return [];
    const files = treeFilePaths(tree.nodes, '', vault.id, (node) => NOTE_FILE.test(node.name));
    const out: ExportNote[] = [];
    for (let i = 0; i < files.length; i += READ_TEXTS_BATCH) {
      const batch = files.slice(i, i + READ_TEXTS_BATCH);
      const replies = await callParvane('parvaneCloudReadTexts', {
        container: rootId,
        nodes: batch.map(({ node }) => ({ id: node.id, blob: node.blob })),
      }) as TextReply[] | undefined;
      const textById = new Map((replies || []).map((reply) => [reply.id, reply.text]));
      batch.forEach(({ node, path }) => {
        const text = textById.get(node.id);
        if (text !== undefined) out.push({ path, text, mtime: node.mtime || undefined });
      });
    }
    return out;
  }

  async function cloudFiles(): Promise<ExportCloudFile[]> {
    const state = await cloudState();
    if (!state) return [];
    const trees = state.containers
      .filter((container) => container.kind !== 'invite' && container.hasKey && state.trees[container.id])
      .map((container) => ({
        id: container.id,
        name: container.kind === 'root' ? names.drive : (container.name || state.trees[container.id].name),
        nodes: state.trees[container.id].nodes,
      }));
    return cloudExportFiles(trees, names.drive);
  }

  let transferSeq = 0;

  async function cloudBlob(file: ExportCloudFile, signal: AbortSignal) {
    const transferId = `export-${Date.now()}-${++transferSeq}`;
    const cancel = () => {
      void callParvane('parvaneCloudCancelDownload', { transferId });
    };
    signal.addEventListener('abort', cancel);
    try {
      return await callParvane('parvaneCloudExportBlob', {
        container: file.container, node: file.node, transferId,
      }) as Blob | undefined;
    } catch (e) {
      if (signal.aborted) throw new ExportError('canceled');
      throw e;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async function planner() {
    const reply = await waitFor(
      () => callParvane('parvanePlannerState') as Promise<PlannerReply | undefined>,
      (state) => Boolean(state.status) && state.status !== 'loading',
    );
    if (reply?.status === 'ready' && reply.raw) return reply.raw;
    // Движок не поднялся — последний сохранённый снимок «Плана» на устройстве
    const cached = await callParvane('parvanePlannerCachedState').catch(() => undefined);
    return cached ? JSON.stringify(cached) : undefined;
  }

  return {
    snapshot: async () => {
      const delay = e2eDelayMs();
      if (delay) await sleep(delay);
      return callParvane('parvaneExportSnapshot') as Promise<ExportSnapshot | undefined>;
    },
    media: (fileId) => callParvane('parvaneExportMedia', { fileId }) as Promise<Blob | undefined>,
    planner,
    notes,
    cloudFiles,
    cloudBlob,
  };
}
