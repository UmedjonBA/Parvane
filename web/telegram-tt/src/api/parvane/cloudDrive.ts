import type { CloudBlobKeys, CloudBlobTransport, CloudUploadResult } from './cloudBlobs';
import type { CloudContainerInfo, CloudSync, CloudSyncStatus } from './v2/cloud';

import { V2Error } from './v2/transport';
import { decryptBlob } from './blobcrypt';
import {
  CloudAbortError, cloudCipherSize, cloudPlainSize, createBlobSink, createFileSink, downloadCloudBlob,
  uploadCloudBlob,
} from './cloudBlobs';

// Parvane (spec 016): методы провайдера раздела «Облако». Дерево и доступ — в
// движке (`v2/cloud.ts`), содержимое файлов — потоковые блобы (`cloudBlobs.ts`);
// здесь — их связка для UI: состояние раздела, загрузка с ходом и отменой,
// скачивание, миниатюры, занятое место. Ход загрузок и скачиваний — событиями
// окна `parvane-cloud-transfer`.

export type CloudBlobInfo = CloudBlobKeys & {
  fileId: string; size: number; chunks: number; mime: string; uploader: string;
};
export type CloudThumbInfo = {
  fileId: string; nonce: string; capability: string; width: number; height: number;
};
export type CloudNodeJson = {
  id: string;
  kind: 'folder' | 'file';
  parent?: string;
  name: string;
  size: number;
  mime: string;
  mtime: number;
  trashed: boolean;
  trashTop: boolean;
  trashedAt: number;
  blob?: CloudBlobInfo;
  thumb?: CloudThumbInfo;
};
export type CloudStateJson = { name: string; count: number; nodes: CloudNodeJson[] };
export type CloudDriveState = {
  status: CloudSyncStatus;
  rootId?: string;
  containers: CloudContainerInfo[];
  trees: Record<string, CloudStateJson>;
  error?: string;
};
export type CloudUsage = { used: number; quota: number; maxFile: number };
export type CloudTransferEvent = {
  id: string;
  kind: 'upload' | 'download';
  done: number;
  total: number;
  state: 'active' | 'done' | 'failed' | 'canceled';
  error?: CloudErrorCode;
};
export type CloudErrorCode = 'offline' | 'no-space' | 'too-large' | 'forbidden' | 'rejected' | 'not-found'
  | 'too-many';
export type CloudResult<T = object> = ({ ok: true } & T) | { ok: false; error: CloudErrorCode };

export type CloudChatFile = { fileId: string; name: string; mime: string; size: number };
type SentFile = CloudBlobKeys & { fileId: string; name: string; mime: string; size: number };

type Deps = {
  log: (message: string) => void;
  self: () => string | undefined;
  cloud: () => CloudSync;
  transport: () => CloudBlobTransport;
  /** Ключи и секрет доступа блоба сообщения чата. */
  mediaKeys: (fileId: string) => { key: string; nonce: string; capability?: string } | undefined;
  /** Расшифрованное содержимое блоба сообщения (запасной путь без копии на сервере). */
  downloadMedia: (fileId: string) => Promise<Blob | undefined>;
  /** Отправить в чат сообщение-файл со ссылкой на готовый блоб. */
  sendFile: (chatId: string, file: SentFile) => Promise<boolean>;
  /** Адрес пользователя по id чата. */
  addressOf: (chatId: string) => string | undefined;
};

// Ответ копии блоба: имена полей — как отдаёт кодек реестра (оба написания)
type CopyReply = { fileId?: string; file_id?: string; size?: string; chunks?: number };

type UploadJob = {
  file: Blob;
  abort: AbortController;
  isRunning: boolean;
  resume?: CloudBlobKeys & { uploadId: string };
};

const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 0.8;
// Картинки крупнее декодировать ради миниатюры не будем (память вкладки)
const THUMB_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
const THUMB_CACHE = 300;
const PREVIEW_CACHE = 6;
const USAGE_TTL_MS = 1500;
const DRIVE_BUCKET = 'BLOB_BUCKET_DRIVE';
const MEDIA_BUCKET = 'BLOB_BUCKET_UNSPECIFIED';
const CAPABILITY_BYTES = 32;
const NODE_ID_BYTES = 16;

export function newCloudNodeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(NODE_ID_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function errorOf(e: unknown): CloudErrorCode {
  const code = e instanceof V2Error ? e.code : String(e);
  if (code.includes('FieldLimit')) return 'too-many';
  if (code.includes('LIMIT')) return 'no-space';
  if (code.includes('FORBIDDEN') || code.includes('Forbidden')) return 'forbidden';
  if (code.includes('NOT_FOUND') || code.includes('NotFound')) return 'not-found';
  if (code.includes('UNAVAILABLE') || code.includes('RATE_LIMITED')) return 'offline';
  return 'rejected';
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

async function newCapability() {
  const capability = crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', capability));
  return { capability: toBase64(capability), hash: toBase64(hash) };
}

function emit(event: CloudTransferEvent) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('parvane-cloud-transfer', { detail: event }));
}

export function createCloudDrive(deps: Deps) {
  const uploads = new Map<string, UploadJob>();
  const downloads = new Map<string, AbortController>();
  const thumbs = new Map<string, Promise<string | undefined>>();
  const previews = new Map<string, Promise<Blob | undefined>>();
  let isEnsureStarted = false;
  let usage: { at: number; value: CloudUsage } | undefined;

  function readTree(container: string): CloudStateJson | undefined {
    const json = deps.cloud().stateJson(container);
    return json ? JSON.parse(json) as CloudStateJson : undefined;
  }

  function findNode(container: string, node: string) {
    return readTree(container)?.nodes.find((n) => n.id === node);
  }

  async function fetchUsage(force?: boolean): Promise<CloudUsage> {
    if (!force && usage && Date.now() - usage.at < USAGE_TTL_MS) return usage.value;
    const got = await deps.transport().blobCall<{
      buckets?: {
        bucket?: string | number; used?: string; quota?: string; maxFile?: string; max_file?: string;
      }[];
    }>('cloud.blob.usage', {});
    const drive = got.buckets?.find((b) => b.bucket === DRIVE_BUCKET || b.bucket === 1);
    const value = {
      used: Number(drive?.used || 0),
      quota: Number(drive?.quota || 0),
      maxFile: Number(drive?.maxFile || drive?.max_file || 0),
    };
    usage = { at: Date.now(), value };
    return value;
  }

  /** Миниатюра картинки: JPEG не больше 320 px по длинной стороне. */
  async function makeThumb(file: Blob): Promise<{ blob: Blob; width: number; height: number } | undefined> {
    if (!file.type.startsWith('image/') || file.size > THUMB_SOURCE_MAX_BYTES) return undefined;
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const blob = await new Promise<Blob | undefined>((resolve) => {
        canvas.toBlob((b) => resolve(b || undefined), 'image/jpeg', THUMB_QUALITY);
      });
      return blob ? { blob, width, height } : undefined;
    } catch {
      return undefined;
    }
  }

  async function runUpload(args: {
    uploadId: string; container: string; parent?: string; name: string; mime: string; mtime: number;
  }): Promise<CloudResult<{ container: string; node: string }>> {
    const job = uploads.get(args.uploadId)!;
    const total = cloudCipherSize(job.file.size);
    const report = (state: CloudTransferEvent['state'], done: number, error?: CloudErrorCode) => emit({
      id: args.uploadId, kind: 'upload', done, total, state, error,
    });
    job.isRunning = true;
    try {
      // Отказ до начала: предел файла и свободное место (FR-022)
      const limits = await fetchUsage(true);
      if (limits.maxFile && total > limits.maxFile) throw new V2Error('TOO_LARGE');
      if (limits.quota && limits.used + total > limits.quota) throw new V2Error('ERROR_CODE_LIMIT');
      report('active', 0);
      const uploaded: CloudUploadResult = await uploadCloudBlob(deps.transport(), job.file, {
        resume: job.resume,
        signal: job.abort.signal,
        onStarted: (state) => {
          job.resume = state;
        },
        onProgress: (done) => report('active', done),
      });
      let thumb: CloudThumbInfo | undefined;
      const picture = await makeThumb(job.file);
      if (picture) {
        try {
          const up = await uploadCloudBlob(
            deps.transport(), picture.blob, { key: uploaded.key, signal: job.abort.signal },
          );
          thumb = {
            fileId: up.fileId, nonce: up.nonce, capability: up.capability, width: picture.width, height: picture.height,
          };
        } catch (e) {
          if (e instanceof CloudAbortError) throw e;
          deps.log(`облако: миниатюра не загружена: ${String(e)}`);
        }
      }
      const node = newCloudNodeId();
      const container = await deps.cloud().apply(args.container, [{
        op: 'create',
        id: node,
        kind: 'file',
        parent: args.parent,
        name: args.name,
        mtime: args.mtime,
        blob: {
          fileId: uploaded.fileId,
          key: uploaded.key,
          nonce: uploaded.nonce,
          capability: uploaded.capability,
          size: uploaded.size,
          chunks: uploaded.chunks,
          mime: args.mime,
          uploader: deps.self() || '',
        },
        thumb,
      }]);
      uploads.delete(args.uploadId);
      usage = undefined;
      report('done', total);
      return { ok: true, container, node };
    } catch (e) {
      if (e instanceof CloudAbortError) {
        uploads.delete(args.uploadId);
        report('canceled', 0);
        return { ok: false, error: 'rejected' };
      }
      const error: CloudErrorCode = e instanceof V2Error && e.code === 'TOO_LARGE' ? 'too-large' : errorOf(e);
      deps.log(`облако: загрузка не удалась: ${String(e)}`);
      job.isRunning = false;
      report('failed', 0, error);
      return { ok: false, error };
    }
  }

  async function loadBlob(blob: CloudBlobKeys & { fileId: string; size: number; chunks: number }, mime: string) {
    const { sink, getBlob } = createBlobSink(mime);
    await downloadCloudBlob(deps.transport(), blob, sink);
    return getBlob();
  }

  function remember<T>(cache: Map<string, Promise<T>>, key: string, limit: number, load: () => Promise<T>) {
    let hit = cache.get(key);
    if (!hit) {
      hit = load();
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
      if (cache.size > limit) cache.delete(cache.keys().next().value!);
    }
    return hit;
  }

  return {
    /** Состояние раздела; первый вызов запускает подключение и синхронизацию. */
    parvaneCloudState(): Promise<CloudDriveState> {
      const cloud = deps.cloud();
      const status = cloud.status();
      if (status !== 'needs-linking' && status !== 'loading' && !isEnsureStarted) {
        isEnsureStarted = true;
        // Частый опрос включает сам раздел (`parvaneCloudSetActive`)
        void cloud.ensure(false);
      }
      const containers = cloud.containers();
      const trees: Record<string, CloudStateJson> = {};
      containers.forEach((c) => {
        const tree = readTree(c.id);
        if (tree) trees[c.id] = tree;
      });
      return Promise.resolve({
        status, rootId: cloud.rootId(), containers, trees, error: cloud.lastError(),
      });
    },

    /** Раздел открыт/закрыт: частый либо редкий опрос. */
    parvaneCloudSetActive({ isActive }: { isActive: boolean }) {
      deps.cloud().setActive(isActive);
      return Promise.resolve(true);
    },

    async parvaneCloudSync() {
      await deps.cloud().syncNow(true);
      return true;
    },

    /** Правки дерева (операции движка); `container` — id либо `root`. */
    async parvaneCloudApply(
      { container, ops }: { container: string; ops: unknown[] },
    ): Promise<CloudResult<{ container: string }>> {
      try {
        return { ok: true, container: await deps.cloud().apply(container, ops) };
      } catch (e) {
        deps.log(`облако: правка отвергнута: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Загрузить файл в папку; ход — событиями `parvane-cloud-transfer`. */
    async parvaneCloudUpload(args: {
      uploadId: string; container: string; parent?: string; name: string; file: Blob; mime?: string; mtime?: number;
    }) {
      const known = uploads.get(args.uploadId);
      uploads.set(args.uploadId, {
        file: args.file, abort: new AbortController(), isRunning: false, resume: known?.resume,
      });
      return runUpload({
        uploadId: args.uploadId,
        container: args.container,
        parent: args.parent,
        name: args.name,
        mime: args.mime || args.file.type || 'application/octet-stream',
        mtime: args.mtime || Date.now(),
      });
    },

    parvaneCloudCancelUpload({ uploadId }: { uploadId: string }) {
      const job = uploads.get(uploadId);
      if (!job) return Promise.resolve(true);
      // Идущая загрузка остановится сама и сообщит об отмене; упавшую раньше просто забываем
      if (job.isRunning) job.abort.abort();
      else uploads.delete(uploadId);
      return Promise.resolve(true);
    },

    /** Скачать файл: в выбранный файл на диске (`handle`) либо в память. */
    async parvaneCloudDownload({ container, node, handle, transferId }: {
      container: string; node: string; handle?: FileSystemFileHandle; transferId: string;
    }): Promise<CloudResult<{ blob?: Blob; name: string }>> {
      const found = findNode(container, node);
      if (!found?.blob) return { ok: false, error: 'not-found' };
      const abort = new AbortController();
      downloads.set(transferId, abort);
      const report = (state: CloudTransferEvent['state'], done: number, error?: CloudErrorCode) => emit({
        id: transferId, kind: 'download', done, total: found.size, state, error,
      });
      try {
        report('active', 0);
        const memory = handle ? undefined : createBlobSink(found.mime || 'application/octet-stream');
        const sink = handle ? await createFileSink(handle) : memory!.sink;
        await downloadCloudBlob(deps.transport(), found.blob, sink, {
          signal: abort.signal,
          onProgress: (done) => report('active', done),
        });
        report('done', found.size);
        return { ok: true, blob: memory?.getBlob(), name: found.name };
      } catch (e) {
        const isCanceled = e instanceof CloudAbortError;
        report(isCanceled ? 'canceled' : 'failed', 0, isCanceled ? undefined : errorOf(e));
        return { ok: false, error: isCanceled ? 'rejected' : errorOf(e) };
      } finally {
        downloads.delete(transferId);
      }
    },

    parvaneCloudCancelDownload({ transferId }: { transferId: string }) {
      downloads.get(transferId)?.abort();
      return Promise.resolve(true);
    },

    /** Содержимое файла для просмотра (небольшой кэш последних). */
    async parvaneCloudOpenBlob({ container, node }: { container: string; node: string }): Promise<Blob | undefined> {
      const found = findNode(container, node);
      if (!found?.blob) return undefined;
      const { blob, mime } = found;
      return remember(previews, blob.fileId, PREVIEW_CACHE, () => loadBlob(blob, mime || 'application/octet-stream'))
        .catch(() => undefined);
    },

    /** Миниатюра файла → blob-URL (кэш на сессию). */
    async parvaneCloudThumb({ container, node }: { container: string; node: string }): Promise<string | undefined> {
      const found = findNode(container, node);
      if (!found?.blob || !found.thumb) return undefined;
      const { thumb, blob } = found;
      return remember(thumbs, thumb.fileId, THUMB_CACHE, async () => {
        // Миниатюра мала — один чанк облака; открытый размер в дереве не хранится
        const got = await deps.transport().downloadBlobCap(thumb.fileId, thumb.capability, 0, 1);
        const cipher = got.parts.get(0);
        const plain = cipher && await decryptBlob(cipher, blob.key, thumb.nonce);
        return plain ? URL.createObjectURL(new Blob([plain as BlobPart], { type: 'image/jpeg' })) : undefined;
      }).catch(() => undefined);
    },

    async parvaneCloudUsage(): Promise<CloudUsage | undefined> {
      return fetchUsage().catch(() => undefined);
    },

    // ── облако и чаты ────────────────────────────────────────────────────────

    /** Файл сообщения чата — в папку облака: копия блоба на сервере, без перекачки. */
    async parvaneCloudSaveFromChat({ file, container, parent }: {
      file: CloudChatFile; container: string; parent?: string;
    }): Promise<CloudResult<{ container: string; node: string }>> {
      try {
        const keys = deps.mediaKeys(file.fileId);
        if (!keys) return { ok: false, error: 'not-found' };
        const fresh = await newCapability();
        let blob: CloudBlobInfo;
        try {
          const copy = await deps.transport().blobCall<CopyReply>(
            'cloud.blob.copy',
            {
              file_id: file.fileId,
              capability: keys.capability || '',
              bucket: DRIVE_BUCKET,
              capability_hash: fresh.hash,
            },
          );
          const copyId = copy.fileId || copy.file_id;
          if (!copyId) throw new V2Error('ERROR_CODE_INVALID');
          blob = {
            fileId: copyId,
            key: keys.key,
            nonce: keys.nonce,
            capability: fresh.capability,
            size: cloudPlainSize(Number(copy.size || 0)),
            chunks: copy.chunks || 1,
            mime: file.mime,
            uploader: deps.self() || '',
          };
        } catch (e) {
          if (!(e instanceof V2Error) || e.code !== 'ERROR_CODE_NOT_FOUND') throw e;
          // Блоб без секрета доступа и не наш: забрать содержимое и загрузить заново
          const content = await deps.downloadMedia(file.fileId);
          if (!content) return { ok: false, error: 'not-found' };
          const up = await uploadCloudBlob(deps.transport(), content);
          blob = { ...up, mime: file.mime, uploader: deps.self() || '' };
        }
        const node = newCloudNodeId();
        const applied = await deps.cloud().apply(container, [{
          op: 'create', id: node, kind: 'file', parent, name: file.name, mtime: Date.now(), blob,
        }]);
        usage = undefined;
        return { ok: true, container: applied, node };
      } catch (e) {
        deps.log(`облако: файл из чата не сохранён: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Файлы облака — в чат: копия блоба в медиа чатов и сообщение-файл. */
    async parvaneCloudSendToChat({ container, nodes, chatId }: {
      container: string; nodes: string[]; chatId: string;
    }): Promise<CloudResult<{ sent: number }>> {
      let sent = 0;
      try {
        for (const id of nodes) {
          const found = findNode(container, id);
          if (!found?.blob) continue;
          const fresh = await newCapability();
          const copy = await deps.transport().blobCall<CopyReply>('cloud.blob.copy', {
            file_id: found.blob.fileId,
            capability: found.blob.capability,
            bucket: MEDIA_BUCKET,
            capability_hash: fresh.hash,
          });
          const copyId = copy.fileId || copy.file_id;
          if (!copyId) throw new V2Error('ERROR_CODE_INVALID');
          const isSent = await deps.sendFile(chatId, {
            fileId: copyId,
            key: found.blob.key,
            nonce: found.blob.nonce,
            capability: fresh.capability,
            name: found.name,
            mime: found.mime || 'application/octet-stream',
            size: found.size,
          });
          if (!isSent) throw new V2Error('ERROR_CODE_NOT_FOUND');
          sent += 1;
        }
        return { ok: true, sent };
      } catch (e) {
        deps.log(`облако: файл в чат не отправлен: ${String(e)}`);
        // Медиа чатов ограничено своим пределом файла и своей квотой
        const error = e instanceof V2Error && e.code === 'ERROR_CODE_LIMIT' ? 'too-large' : errorOf(e);
        return { ok: false, error };
      }
    },

    // ── совместные папки ─────────────────────────────────────────────────────

    async parvaneCloudCreateShared({ name }: { name: string }): Promise<CloudResult<{ container: string }>> {
      try {
        return { ok: true, container: await deps.cloud().createFolder(name) };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Выдать доступ пользователю (по id чата с ним) либо сменить его роль. */
    async parvaneCloudShare({
      container, chatId, user, role, inviteText,
    }: {
      container: string; chatId?: string; user?: string; role: 'editor' | 'reader'; inviteText: string;
    }): Promise<CloudResult> {
      const address = user || (chatId ? deps.addressOf(chatId) : undefined);
      if (!address) return { ok: false, error: 'not-found' };
      try {
        await deps.cloud().share(container, address, role, inviteText);
        return { ok: true };
      } catch (e) {
        deps.log(`облако: доступ не выдан: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
    },

    async parvaneCloudUnshare({ container, user }: { container: string; user: string }): Promise<CloudResult> {
      try {
        await deps.cloud().unshare(container, user);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },

    async parvaneCloudAnswerInvite(
      { container, isAccepted }: { container: string; isAccepted: boolean },
    ): Promise<CloudResult> {
      try {
        await deps.cloud().answerInvite(container, isAccepted);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },

    async parvaneCloudLeave({ container }: { container: string }): Promise<CloudResult> {
      try {
        await deps.cloud().leave(container);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Удалить свою совместную папку: стереть содержимое, убрать участников. */
    async parvaneCloudRemoveShared({ container }: { container: string }): Promise<CloudResult> {
      try {
        const top = (readTree(container)?.nodes || []).filter((n) => !n.parent);
        const at = Date.now();
        if (top.length) await deps.cloud().apply(container, top.map((n) => ({ op: 'purge', id: n.id, at })));
        await deps.cloud().removeFolder(container);
        usage = undefined;
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },
  };
}

export type CloudDrive = ReturnType<typeof createCloudDrive>;
