import type {
  BlobSession, CloudBlobKeys, CloudBlobTransport, CloudUploadResult,
} from './cloudBlobs';
import type {
  CloudContainerInfo, CloudDriveCheck, CloudSync, CloudSyncStatus,
} from './v2/cloud';
import type { WireMessageContent } from './wire';

import { V2Error } from './v2/transport';
import { decryptBlob } from './blobcrypt';
import {
  CloudAbortError, cloudCipherSize, cloudPlainSize, createBlobSink, createFileSink, createLimiter,
  downloadCloudBlob, uploadCloudBlob, withRetry,
} from './cloudBlobs';
import {
  base64ToBytes, buildLinkPlan, buildLinkUrl, buildManifest, bytesToBase64, bytesToBase64Url, LINK_MANIFEST_MAX_BYTES,
  LINK_MAX_FILES, LINK_MAX_THUMBS, LINK_OWNER_RECORD_MAX_BYTES, type LinkKind, type LinkManifestThumb, newLinkKey,
  openOwnerRecord, runPool, sealManifest, sealOwnerRecord,
} from './cloudLinks';

// Parvane (spec 016): методы провайдера раздела «Облако». Дерево и доступ — в
// движке (`v2/cloud.ts`), содержимое файлов — потоковые блобы (`cloudBlobs.ts`);
// здесь — их связка для UI: состояние раздела, загрузка с ходом и отменой,
// скачивание, миниатюры, занятое место. Ход загрузок и скачиваний — событиями
// окна `parvane-cloud-transfer`. Разобранные деревья кэшируются по ревизии
// движка (A8); мелкие скачивания (миниатюры, картинки холста, тексты заметок)
// идут серией по одному анонимному соединению (A9).

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
export type CloudUsage = {
  used: number; quota: number; maxFile: number;
  /** Байты копий всех ссылок (входят в `used`). */
  linksBytes: number;
};
export type CloudLinkState = 'preparing' | 'active' | 'expired';
/** Ссылка для людей без аккаунта (spec 022), как её видит владелец. */
export type CloudLinkInfo = {
  id: string;
  state: CloudLinkState;
  /** Unix-секунды; `expiresAt = 0` — без срока. */
  createdAt: number;
  expiresAt: number;
  bytes: number;
  files: number;
  /** Из записи владельца; у готовящейся ссылки и при недоступном ключе диска их нет. */
  name?: string;
  kind?: LinkKind;
  url?: string;
  source?: { container: string; node: string };
};
export type CloudLinkProgress = { id: string; done: number; total: number };
export type CloudTransferEvent = {
  id: string;
  kind: 'upload' | 'download' | 'move';
  done: number;
  total: number;
  state: 'active' | 'done' | 'failed' | 'canceled';
  error?: CloudErrorCode;
};
export type CloudErrorCode = 'offline' | 'no-space' | 'too-large' | 'forbidden' | 'rejected' | 'not-found'
  | 'too-many' | 'link-too-many' | 'link-limit' | 'link-disabled';
export type CloudResult<T = object> = ({ ok: true } & T) | { ok: false; error: CloudErrorCode };

export type CloudMoveItem = { id: string; name: string };
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

// Ответы методов ссылок: имена полей — оба написания, числа u64 — строками
type LinkInfoReply = {
  linkId?: string; link_id?: string; state?: string | number;
  createdAt?: string | number; created_at?: string | number;
  expiresAt?: string | number; expires_at?: string | number;
  bytes?: string | number; files?: number;
  ownerRecord?: string; owner_record?: string;
};
type LinkAddReply = {
  fileId?: string; file_id?: string; size?: string | number; chunks?: number;
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
// Миниатюр качается не больше четырёх разом: список из 30 картинок иначе качал бы все 30 сразу
const THUMB_PARALLEL = 4;
// Содержимое для просмотра (картинки холста, предпросмотр): кэш по байтам, не по счёту —
// шесть файлов по 32 МБ держали бы 192 МБ памяти вкладки
const PREVIEW_CACHE_BYTES = 128 * 1024 * 1024;
// Картинок холста разом качается не больше трёх, остальные ждут своей очереди
const PREVIEW_PARALLEL = 3;
// Тексты заметок пакетом (`parvaneCloudReadTexts`): окно одновременных скачиваний
const READ_TEXTS_PARALLEL = 12;
// Серия анонимного соединения для мелких скачиваний живёт ещё столько после последнего
// потребителя: следующая миниатюра того же списка не открывает соединение заново
const SERIES_GRACE_MS = 1500;
const TEXT_MIME = 'text/markdown';
const USAGE_TTL_MS = 1500;
const DRIVE_BUCKET = 'BLOB_BUCKET_DRIVE';
const MEDIA_BUCKET = 'BLOB_BUCKET_UNSPECIFIED';
const CAPABILITY_BYTES = 32;
const NODE_ID_BYTES = 16;
// Перенос между контейнерами идёт порциями: копия блобов, узлы в назначении,
// удаление в источнике — лишнее место занято не дольше одной порции
const MOVE_CHUNK_FILES = 20;
const MOVE_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_NODES = 8000;
// Ссылки (spec 022): копии файлов идут несколькими запросами сразу; большая
// копия на сервере дольше одного запроса — повторять, пока сервер отвечает «ещё идёт»
const LINK_ADD_WINDOW = 4;
const LINK_ADD_ROUNDS = 6;
const LINK_STATES: Record<string, CloudLinkState> = {
  LINK_STATE_PREPARING: 'preparing',
  1: 'preparing',
  LINK_STATE_ACTIVE: 'active',
  2: 'active',
  LINK_STATE_EXPIRED: 'expired',
  3: 'expired',
};

export function newCloudNodeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(NODE_ID_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function errorOf(e: unknown): CloudErrorCode {
  const code = e instanceof V2Error ? e.code : String(e);
  if (code === 'LINK_TOO_MANY') return 'link-too-many';
  if (code === 'LINK_LIMIT') return 'link-limit';
  if (code === 'LINK_DISABLED') return 'link-disabled';
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

/** Общая серия анонимного соединения для мелких скачиваний (A9): открывается первым
 * потребителем, живёт, пока есть потребители, и ещё `graceMs` после последнего. Без
 * `withBlobSession` у транспорта потребители идут напрямую (соединение на блоб). */
export function createSharedSession(transport: () => CloudBlobTransport, graceMs = SERIES_GRACE_MS) {
  type Holder = {
    session: Promise<BlobSession>; users: number; end: () => void; timer?: ReturnType<typeof setTimeout>;
  };
  let current: Holder | undefined;
  return async function inSeries<T>(fn: (session: BlobSession) => Promise<T>): Promise<T> {
    const t = transport();
    if (!t.withBlobSession) return fn(t);
    let holder = current;
    if (!holder) {
      let open!: (session: BlobSession) => void;
      let fail!: (e: unknown) => void;
      let end!: () => void;
      const session = new Promise<BlobSession>((resolve, reject) => {
        open = resolve;
        fail = reject;
      });
      const done = new Promise<void>((resolve) => {
        end = resolve;
      });
      const made: Holder = { session, users: 0, end };
      holder = made;
      current = made;
      t.withBlobSession(async (s) => {
        open(s);
        await done;
      }).catch((e: unknown) => {
        fail(e);
        if (current === made) current = undefined;
      });
      session.catch(() => undefined);
    }
    if (holder.timer) {
      clearTimeout(holder.timer);
      holder.timer = undefined;
    }
    const taken = holder;
    taken.users += 1;
    try {
      return await fn(await taken.session);
    } finally {
      taken.users -= 1;
      if (!taken.users) {
        taken.timer = setTimeout(() => {
          if (current === taken) current = undefined;
          taken.end();
        }, graceMs);
      }
    }
  };
}

/** Пределы кэшей (в тестах — меньше). */
export type CloudDriveLimits = { thumbCache: number; previewCacheBytes: number };

export function createCloudDrive(deps: Deps, caps: Partial<CloudDriveLimits> = {}) {
  const thumbCache = caps.thumbCache ?? THUMB_CACHE;
  const previewCacheBytes = caps.previewCacheBytes ?? PREVIEW_CACHE_BYTES;
  const uploads = new Map<string, UploadJob>();
  const downloads = new Map<string, AbortController>();
  const moves = new Map<string, AbortController>();
  const links = new Map<string, AbortController>();
  const thumbs = new Map<string, Promise<string | undefined>>();
  const previews = new Map<string, { loading: Promise<Blob | undefined>; bytes: number }>();
  let previewBytes = 0;
  const runThumb = createLimiter(THUMB_PARALLEL);
  const runPreview = createLimiter(PREVIEW_PARALLEL);
  const inSmallSeries = createSharedSession(() => deps.transport());
  // Разобранные деревья по контейнеру — пока ревизия деревьев в движке та же (A8)
  const treeCache = new Map<string, CloudStateJson | undefined>();
  let treeCacheRevision = -1;
  let isEnsureStarted = false;
  let usage: { at: number; value: CloudUsage } | undefined;

  function readTree(container: string): CloudStateJson | undefined {
    const cloud = deps.cloud();
    const revision = cloud.revision();
    if (revision !== treeCacheRevision) {
      treeCache.clear();
      treeCacheRevision = revision;
    }
    if (treeCache.has(container)) return treeCache.get(container);
    const json = cloud.stateJson(container);
    const tree = json ? JSON.parse(json) as CloudStateJson : undefined;
    treeCache.set(container, tree);
    return tree;
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
      linksBytes?: string; links_bytes?: string;
    }>('cloud.blob.usage', {});
    const drive = got.buckets?.find((b) => b.bucket === DRIVE_BUCKET || b.bucket === 1);
    const value = {
      used: Number(drive?.used || 0),
      quota: Number(drive?.quota || 0),
      maxFile: Number(drive?.maxFile || drive?.max_file || 0),
      linksBytes: Number(got.linksBytes || got.links_bytes || 0),
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

  /** Содержимое блоба целиком в память; `session` — серия (A9), без неё соединение своё у блоба. */
  async function loadBlob(
    blob: CloudBlobKeys & { fileId: string; size: number; chunks: number }, mime: string, session?: BlobSession,
  ) {
    const { sink, getBlob } = createBlobSink(mime);
    await downloadCloudBlob(session || deps.transport(), blob, sink);
    return getBlob();
  }

  /** Кэш последних `limit` обещаний; вытесненное отдаётся в `onEvict` (D9: blob-URL миниатюры освобождается). */
  function remember<T>(
    cache: Map<string, Promise<T>>, key: string, limit: number, load: () => Promise<T>, onEvict?: (value: T) => void,
  ) {
    let hit = cache.get(key);
    if (!hit) {
      hit = load();
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
      while (cache.size > limit) {
        const oldest = cache.keys().next().value!;
        const evicted = cache.get(oldest)!;
        cache.delete(oldest);
        if (onEvict) evicted.then(onEvict).catch(() => undefined);
      }
    }
    return hit;
  }

  function forgetPreview(fileId: string) {
    const entry = previews.get(fileId);
    if (!entry) return;
    previews.delete(fileId);
    previewBytes -= entry.bytes;
  }

  /** Кэш содержимого для просмотра с бюджетом по байтам (D6): старое вытесняется, пока не уложимся. */
  function rememberPreview(fileId: string, bytes: number, load: () => Promise<Blob | undefined>) {
    const hit = previews.get(fileId);
    if (hit) return hit.loading;
    const entry = { loading: load(), bytes };
    previews.set(fileId, entry);
    previewBytes += bytes;
    entry.loading.catch(() => forgetPreview(fileId));
    for (const key of previews.keys()) {
      if (previewBytes <= previewCacheBytes || key === fileId) break;
      forgetPreview(key);
    }
    return entry.loading;
  }

  /** Независимая копия блоба в облаке под новым секретом доступа (без перекачки). */
  async function copyDriveBlob(fileId: string, capability: string, signal?: AbortSignal) {
    const fresh = await newCapability();
    const copy = await withRetry(() => deps.transport().blobCall<CopyReply>('cloud.blob.copy', {
      file_id: fileId, capability, bucket: DRIVE_BUCKET, capability_hash: fresh.hash,
    }), signal);
    const copyId = copy.fileId || copy.file_id;
    if (!copyId) throw new V2Error('ERROR_CODE_INVALID');
    return { fileId: copyId, capability: fresh.capability };
  }

  function dropBlobs(ids: string[]) {
    ids.forEach((id) => {
      void deps.transport().blobCall('cloud.blob.delete', { file_id: id }).catch(() => undefined);
    });
  }

  /** Перенести узлы со всем вложенным в другой контейнер: копия в назначение,
   * удаление в источнике (FR-032). `wrapper` — папка источника, чьё содержимое
   * переносится, а сама она стирается. Блобы копируются на сервере: общий блоб
   * двух контейнеров стёрло бы устройство, увидевшее удаление в источнике. */
  async function moveNodes(args: {
    from: string; items: CloudMoveItem[]; to: string; parent?: string; wrapper?: string;
    signal?: AbortSignal; onProgress?: (done: number, total: number) => void;
  }) {
    const cloud = deps.cloud();
    const source = readTree(args.from)?.nodes || [];
    const byId = new Map(source.map((n) => [n.id, n]));
    const childrenOf = (id: string) => source.filter((n) => n.parent === id);
    const newIds = new Map<string, string>();
    const names = new Map(args.items.map((i) => [i.id, i.name]));
    const folders: CloudNodeJson[] = [];
    const files: CloudNodeJson[] = [];
    // Лежащее в корзине остаётся в источнике: поднимается в корень, чтобы не стереться с папкой
    const rescued: CloudNodeJson[] = args.wrapper ? childrenOf(args.wrapper).filter((n) => n.trashTop) : [];
    const queue = args.items.map((i) => byId.get(i.id)).filter((n): n is CloudNodeJson => Boolean(n && !n.trashed));
    const tops = new Set(queue.map((n) => n.id));
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      newIds.set(node.id, newCloudNodeId());
      if (node.kind === 'file') {
        if (node.blob) files.push(node);
        continue;
      }
      folders.push(node);
      childrenOf(node.id).forEach((child) => {
        if (!child.trashed) queue.push(child);
        else if (child.trashTop) rescued.push(child);
      });
    }
    if ((readTree(args.to)?.nodes.length || 0) + folders.length + files.length > MAX_NODES) {
      throw new V2Error('FieldLimit');
    }
    const placeOf = (node: CloudNodeJson) => ({
      id: newIds.get(node.id)!,
      parent: tops.has(node.id) ? args.parent : newIds.get(node.parent!),
      name: names.get(node.id) || node.name,
    });
    if (folders.length) {
      await cloud.apply(args.to, folders.map((n) => ({
        op: 'create', kind: 'folder', mtime: n.mtime || undefined, ...placeOf(n),
      })));
    }
    const total = files.reduce((sum, n) => sum + n.size, 0);
    let done = 0;
    args.onProgress?.(0, total);
    const self = deps.self() || '';
    for (let start = 0; start < files.length;) {
      const creates: unknown[] = [];
      const copied: string[] = [];
      const purges: unknown[] = [];
      let bytes = 0;
      try {
        while (start < files.length && creates.length < MOVE_CHUNK_FILES && bytes < MOVE_CHUNK_BYTES) {
          const node = files[start];
          const blob = node.blob!;
          const copy = await copyDriveBlob(blob.fileId, blob.capability, args.signal);
          copied.push(copy.fileId);
          let thumb: CloudThumbInfo | undefined;
          if (node.thumb) {
            try {
              const thumbCopy = await copyDriveBlob(node.thumb.fileId, node.thumb.capability, args.signal);
              copied.push(thumbCopy.fileId);
              thumb = { ...node.thumb, ...thumbCopy };
            } catch (e) {
              if (e instanceof CloudAbortError) throw e;
              deps.log(`облако: миниатюра не перенесена: ${String(e)}`);
            }
          }
          creates.push({
            op: 'create',
            kind: 'file',
            mtime: node.mtime,
            ...placeOf(node),
            blob: { ...blob, ...copy, uploader: self },
            thumb,
          });
          purges.push({ op: 'purge', id: node.id, at: Date.now() });
          bytes += node.size;
          start += 1;
        }
        await cloud.apply(args.to, creates);
      } catch (e) {
        // Скопированное, но не попавшее в дерево, место занимать не должно
        dropBlobs(copied);
        throw e;
      }
      // Источник стирается только после того, как сервер принял узлы назначения
      if (!await cloud.flush(args.to)) throw new V2Error('ERROR_CODE_FORBIDDEN');
      await cloud.apply(args.from, purges);
      await cloud.flush(args.from);
      usage = undefined;
      done += bytes;
      args.onProgress?.(done, total);
    }
    const at = Date.now();
    const tail: unknown[] = rescued.map((n) => ({
      op: 'move', id: n.id, parent: undefined, name: n.name,
    }));
    folders.filter((n) => tops.has(n.id)).forEach((n) => tail.push({ op: 'purge', id: n.id, at }));
    if (args.wrapper) tail.push({ op: 'purge', id: args.wrapper, at });
    if (tail.length) {
      await cloud.apply(args.from, tail);
      await cloud.flush(args.from);
    }
    return total;
  }

  async function removeShared(container: string) {
    const top = (readTree(container)?.nodes || []).filter((n) => !n.parent);
    const at = Date.now();
    if (top.length) await deps.cloud().apply(container, top.map((n) => ({ op: 'purge', id: n.id, at })));
    await deps.cloud().removeFolder(container);
    usage = undefined;
  }

  /** Перенос с ходом и отменой (события `parvane-cloud-transfer`, вид `move`). */
  async function runMove(
    transferId: string,
    run: (signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<number>,
  ): Promise<CloudErrorCode | undefined> {
    const abort = new AbortController();
    moves.set(transferId, abort);
    let total = 0;
    const report = (state: CloudTransferEvent['state'], done: number, error?: CloudErrorCode) => emit({
      id: transferId, kind: 'move', done, total, state, error,
    });
    try {
      total = await run(abort.signal, (done, all) => {
        total = all;
        report('active', done);
      });
      report('done', total);
      return undefined;
    } catch (e) {
      if (e instanceof CloudAbortError) {
        report('canceled', 0);
        return 'rejected';
      }
      deps.log(`облако: перенос не удался: ${String(e)}`);
      report('failed', 0, errorOf(e));
      return errorOf(e);
    } finally {
      moves.delete(transferId);
      usage = undefined;
    }
  }

  // ── ссылки для людей без аккаунта (spec 022) ───────────────────────────────

  /** Ключи личного диска по эпохам (base64): ими шифруются записи владельца. */
  function driveKeys(): Map<number, string> {
    const cloud = deps.cloud();
    const root = cloud.rootId();
    try {
      const exported = JSON.parse(cloud.keysExport() || '[]') as { id: string; keys: [number, string][] }[];
      return new Map(exported.find((c) => c.id === root)?.keys || []);
    } catch {
      return new Map();
    }
  }

  async function readLink(reply: LinkInfoReply, keys: Map<number, string>): Promise<CloudLinkInfo | undefined> {
    const id = reply.linkId || reply.link_id;
    if (!id) return undefined;
    const info: CloudLinkInfo = {
      id,
      state: LINK_STATES[String(reply.state)] || 'preparing',
      createdAt: Number(reply.createdAt || reply.created_at || 0),
      expiresAt: Number(reply.expiresAt || reply.expires_at || 0),
      bytes: Number(reply.bytes || 0),
      files: reply.files || 0,
    };
    const wire = reply.ownerRecord || reply.owner_record;
    const record = wire ? await openOwnerRecord(base64ToBytes(wire), keys, id).catch(() => undefined) : undefined;
    if (!record) return info;
    return {
      ...info,
      name: record.name,
      kind: record.kind,
      source: record.source,
      url: buildLinkUrl(window.location.origin, id, record.key),
    };
  }

  async function revokeLink(linkId: string) {
    await withRetry(() => deps.transport().blobCall('cloud.link.revoke', { link_id: linkId }));
    usage = undefined;
  }

  /** Создать ссылку: копии файлов на сервере, зашифрованный список, запись владельца. */
  async function createLink(args: {
    container: string; node?: string; name?: string; ttlDays: number; signal: AbortSignal;
    onProgress: (done: number, total: number) => void;
  }): Promise<CloudLinkInfo> {
    const { signal } = args;
    const transport = deps.transport();
    const plan = buildLinkPlan(readTree(args.container)?.nodes || [], args.node || undefined, args.name);
    if ('error' in plan) throw new V2Error(plan.error === 'too-many' ? 'LINK_TOO_MANY' : 'ERROR_CODE_NOT_FOUND');
    // Отказ до начала: места должно хватить на все копии
    const limits = await fetchUsage(true);
    const copyBytes = plan.files.reduce((sum, f) => sum + cloudCipherSize(f.node.blob!.size), 0);
    if (limits.quota && limits.used + copyBytes > limits.quota) throw new V2Error('ERROR_CODE_LIMIT');
    const keys = driveKeys();
    const epoch = Math.max(-1, ...keys.keys());
    const driveKey = keys.get(epoch);
    // Запись владельца шифруется ключом личного диска: без него ссылку потом не показать
    if (!driveKey) throw new V2Error('ERROR_CODE_INVALID');

    // Место и число файлов проверены выше: отказ `LIMIT` здесь — предел числа ссылок аккаунта,
    // `FORBIDDEN` — ссылки выключены на сервере. Запрос без повтора: он не идемпотентен, повтор после
    // потерянного ответа оставил бы вторую, недоделанную ссылку
    const created = await transport.blobCall<{ linkId?: string; link_id?: string }>(
      'cloud.link.create', { ttl_days: args.ttlDays },
    ).catch((e: unknown) => {
      if (e instanceof V2Error && e.code === 'ERROR_CODE_LIMIT') throw new V2Error('LINK_LIMIT');
      if (e instanceof V2Error && e.code === 'ERROR_CODE_FORBIDDEN') throw new V2Error('LINK_DISABLED');
      throw e;
    });
    const linkId = created.linkId || created.link_id;
    if (!linkId) throw new V2Error('ERROR_CODE_INVALID');
    try {
      const copies = new Map<string, {
        fileId: string; blobSize: number; chunks: number; thumb?: LinkManifestThumb;
      }>();
      // Миниатюры — копиями в том же пределе блобов ссылки, сколько останется после самих файлов
      const thumbIds = new Set(plan.files.filter(({ node }) => node.thumb).map(({ node }) => node.id)
        .slice(0, Math.min(LINK_MAX_THUMBS, LINK_MAX_FILES - plan.files.length)));
      const addCopy = async (fileId: string, capability: string) => {
        const request = { link_id: linkId, file_id: fileId, capability };
        // Метод идемпотентен: повтор с тем же источником отдаёт уже сделанную копию
        for (let round = 1; ; round++) {
          try {
            const copy = await withRetry(() => transport.blobCall<LinkAddReply>('cloud.link.add', request), signal);
            const copyId = copy.fileId || copy.file_id;
            if (!copyId) throw new V2Error('ERROR_CODE_INVALID');
            return { fileId: copyId, size: Number(copy.size || 0), chunks: copy.chunks };
          } catch (e) {
            const isStillCopying = e instanceof V2Error && e.code === 'ERROR_CODE_UNAVAILABLE';
            if (!isStillCopying || round >= LINK_ADD_ROUNDS) throw e;
          }
        }
      };
      let done = 0;
      args.onProgress(0, plan.files.length);
      await runPool(plan.files, LINK_ADD_WINDOW, async ({ node }) => {
        const blob = node.blob!;
        const copy = await addCopy(blob.fileId, blob.capability);
        // Миниатюра необязательна: не скопировалась — файл в ссылке без неё
        const thumbCopy = node.thumb && thumbIds.has(node.id)
          ? await addCopy(node.thumb.fileId, node.thumb.capability).catch((e: unknown) => {
            if (e instanceof CloudAbortError) throw e;
            return undefined;
          })
          : undefined;
        copies.set(node.id, {
          fileId: copy.fileId,
          blobSize: copy.size || cloudCipherSize(blob.size),
          chunks: copy.chunks || blob.chunks,
          ...(thumbCopy?.size && {
            thumb: { fileId: thumbCopy.fileId, nonce: node.thumb!.nonce, blobSize: thumbCopy.size },
          }),
        });
        done += 1;
        args.onProgress(done, plan.files.length);
      });
      if (signal.aborted) throw new CloudAbortError();

      const linkKey = newLinkKey();
      const createdAt = Math.floor(Date.now() / 1000);
      const manifest = await sealManifest(buildManifest(plan, copies, createdAt), linkKey, linkId);
      if (manifest.length > LINK_MANIFEST_MAX_BYTES) throw new V2Error('LINK_TOO_MANY');
      const key = bytesToBase64Url(linkKey);
      const source = { container: args.container, node: args.node || '' };
      const ownerRecord = await sealOwnerRecord({
        name: plan.name, kind: plan.kind, key, epoch, source,
      }, base64ToBytes(driveKey), linkId);
      if (ownerRecord.length > LINK_OWNER_RECORD_MAX_BYTES) throw new V2Error('ERROR_CODE_INVALID');
      const published = await withRetry(() => transport.blobCall<{
        expiresAt?: string | number; expires_at?: string | number;
      }>('cloud.link.publish', {
        link_id: linkId, manifest: bytesToBase64(manifest), owner_record: bytesToBase64(ownerRecord),
      }), signal);
      usage = undefined;
      return {
        id: linkId,
        state: 'active',
        createdAt,
        expiresAt: Number(published.expiresAt || published.expires_at || 0),
        bytes: Array.from(copies.values()).reduce((sum, c) => sum + c.blobSize, 0),
        files: plan.files.length,
        name: plan.name,
        kind: plan.kind,
        source,
        url: buildLinkUrl(window.location.origin, linkId, key),
      };
    } catch (e) {
      // Недоделанная ссылка не должна занимать место: её копии убирает отзыв
      await revokeLink(linkId).catch((err: unknown) => {
        deps.log(`облако: недоделанная ссылка не отозвана: ${String(err)}`);
      });
      throw e;
    }
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

    /** Содержимое файла для просмотра (кэш последних с бюджетом по байтам; не больше трёх
     * загрузок разом, серия по общему соединению). `blob` узла из UI избавляет от поиска в дереве. */
    async parvaneCloudOpenBlob({ container, node, blob: given }: {
      container: string; node: string; blob?: CloudBlobInfo;
    }): Promise<Blob | undefined> {
      const found = given ? { blob: given, mime: given.mime } : findNode(container, node);
      if (!found?.blob) return undefined;
      const { blob, mime } = found;
      return rememberPreview(blob.fileId, blob.size, () => runPreview(() => inSmallSeries(
        (session) => loadBlob(blob, mime || 'application/octet-stream', session),
      ))).catch(() => undefined);
    },

    /** Текстовый файл (заметка, холст): создать либо заменить содержимое существующего узла.
     * `expectedFileId` — содержимое, от которого шла правка: если узел с тех пор изменился (другое
     * устройство), запись не делается и возвращается `conflict` с текущим содержимым — сводит вызывающий. */
    async parvaneCloudWriteText(args: {
      container: string; parent?: string; node?: string; name: string; text: string; mime?: string;
      expectedFileId?: string;
      // Идентификатор создаваемого узла: одинаковый на всех устройствах — два создания сведутся в один узел
      newNodeId?: string;
      // Папка, создаваемая той же правкой, что и файл (он ложится в неё): либо появятся оба узла, либо ни одного
      newFolder?: { id: string; name: string };
    }): Promise<CloudResult<{ container: string; node: string; fileId: string; conflict?: string }>> {
      try {
        const existing = args.node ? findNode(args.container, args.node) : undefined;
        if (args.node && !existing) return { ok: false, error: 'not-found' };
        if (existing?.blob && args.expectedFileId && existing.blob.fileId !== args.expectedFileId) {
          const current = await loadBlob(existing.blob, existing.mime || TEXT_MIME);
          if (!current) return { ok: false, error: 'offline' };
          return {
            ok: true,
            container: args.container,
            node: args.node!,
            fileId: existing.blob.fileId,
            conflict: await current.text(),
          };
        }
        const mime = args.mime || TEXT_MIME;
        const uploaded = await uploadCloudBlob(deps.transport(), new Blob([args.text], { type: mime }));
        const blob = {
          fileId: uploaded.fileId,
          key: uploaded.key,
          nonce: uploaded.nonce,
          capability: uploaded.capability,
          size: uploaded.size,
          chunks: uploaded.chunks,
          mime,
          uploader: deps.self() || '',
        };
        const node = args.node || args.newNodeId || newCloudNodeId();
        const mtime = Date.now();
        const folder = existing ? undefined : args.newFolder;
        const container = await deps.cloud().apply(args.container, existing
          ? [{
            op: 'setBlob', id: node, blob, mtime,
          }]
          : [
            ...(folder ? [{
              op: 'create', id: folder.id, kind: 'folder', parent: args.parent, name: folder.name,
            }] : []),
            {
              op: 'create', id: node, kind: 'file', parent: folder?.id || args.parent, name: args.name, mtime, blob,
            },
          ]);
        usage = undefined;
        return {
          ok: true, container, node, fileId: uploaded.fileId,
        };
      } catch (e) {
        deps.log(`облако: текст не записан: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Сверка личного диска с сервером перед правкой «только если ещё нет» (см. `CloudSync.checkDrive`). */
    parvaneCloudCheckDrive(): Promise<CloudDriveCheck> {
      return deps.cloud().checkDrive();
    },

    /** Содержимое текстового файла и идентификатор его версии (для `expectedFileId`).
     * `blob` узла из UI избавляет от поиска в дереве. */
    async parvaneCloudReadText(
      { container, node, blob: given }: { container: string; node: string; blob?: CloudBlobInfo },
    ): Promise<{ text: string; fileId: string } | undefined> {
      const found = given ? { blob: given, mime: given.mime } : findNode(container, node);
      if (!found?.blob) return undefined;
      const target = found.blob;
      try {
        const blob = await inSmallSeries((session) => loadBlob(target, found.mime || TEXT_MIME, session));
        return blob ? { text: await blob.text(), fileId: target.fileId } : undefined;
      } catch (e) {
        deps.log(`облако: текст не прочитан: ${String(e)}`);
        return undefined;
      }
    },

    /** Тексты нескольких файлов пакетом (заметки хранилища): один разбор дерева, одна серия
     * скачиваний по общему соединению, не больше `READ_TEXTS_PARALLEL` разом. Узел без `blob`
     * ищется в дереве; ответ — в порядке запроса, у каждого либо `text`+`fileId`, либо `error`. */
    async parvaneCloudReadTexts({ container, nodes }: {
      container: string; nodes: { id: string; blob?: CloudBlobInfo }[];
    }): Promise<{ id: string; text?: string; fileId?: string; error?: CloudErrorCode }[]> {
      const tree = nodes.some((n) => !n.blob) ? readTree(container) : undefined;
      const byId = new Map((tree?.nodes || []).map((n) => [n.id, n]));
      const targets = nodes.map(({ id, blob }) => ({ id, blob: blob || byId.get(id)?.blob }));
      const read = async (session: BlobSession) => {
        const run = createLimiter(READ_TEXTS_PARALLEL);
        return Promise.all(targets.map(({ id, blob }) => run(async () => {
          if (!blob) return { id, error: 'not-found' as CloudErrorCode };
          try {
            const got = await loadBlob(blob, blob.mime || TEXT_MIME, session);
            if (!got) return { id, error: 'not-found' as CloudErrorCode };
            return { id, text: await got.text(), fileId: blob.fileId };
          } catch (e) {
            deps.log(`облако: текст не прочитан: ${String(e)}`);
            return { id, error: errorOf(e) };
          }
        })));
      };
      if (!targets.some((t) => t.blob)) return read(deps.transport());
      const transport = deps.transport();
      if (!transport.withBlobSession) return read(transport);
      return transport.withBlobSession(read).catch((e: unknown) => {
        deps.log(`облако: тексты не прочитаны: ${String(e)}`);
        return targets.map(({ id, blob }) => ({ id, error: blob ? errorOf(e) : 'not-found' }));
      });
    },

    /** Миниатюра файла → blob-URL (кэш на сессию; вытесненный адрес освобождается). Качается не
     * больше `THUMB_PARALLEL` разом, серией по общему соединению. `blob`/`thumb` узла из UI
     * избавляют от поиска в дереве. */
    async parvaneCloudThumb({
      container, node, blob: givenBlob, thumb: givenThumb,
    }: {
      container: string; node: string; blob?: CloudBlobInfo; thumb?: CloudThumbInfo;
    }): Promise<string | undefined> {
      const found = givenBlob && givenThumb ? { blob: givenBlob, thumb: givenThumb } : findNode(container, node);
      if (!found?.blob || !found.thumb) return undefined;
      const { thumb, blob } = found;
      return remember(thumbs, thumb.fileId, thumbCache, () => runThumb(() => inSmallSeries(async (session) => {
        // Миниатюра мала — один чанк облака; открытый размер в дереве не хранится
        const got = await session.downloadBlobCap(thumb.fileId, thumb.capability, 0, 1);
        const cipher = got.parts.get(0);
        const plain = cipher && await decryptBlob(cipher, blob.key, thumb.nonce);
        return plain ? URL.createObjectURL(new Blob([plain as BlobPart], { type: 'image/jpeg' })) : undefined;
      })), (url) => {
        if (url) URL.revokeObjectURL(url);
      }).catch(() => undefined);
    },

    /** Переместить узлы в папку другого контейнера (личный диск ↔ совместная папка). */
    async parvaneCloudMove({
      from, items, to, parent, transferId,
    }: {
      from: string; items: CloudMoveItem[]; to: string; parent?: string; transferId: string;
    }): Promise<CloudResult> {
      const error = await runMove(transferId, (signal, onProgress) => moveNodes({
        from, items, to, parent, signal, onProgress,
      }));
      return error ? { ok: false, error } : { ok: true };
    },

    parvaneCloudCancelMove({ transferId }: { transferId: string }) {
      moves.get(transferId)?.abort();
      return Promise.resolve(true);
    },

    /** Сделать папку личного диска совместной: новый контейнер с её названием и содержимым. */
    async parvaneCloudShareFolder({ container, node, transferId }: {
      container: string; node: string; transferId: string;
    }): Promise<CloudResult<{ container: string }>> {
      const folder = findNode(container, node);
      if (!folder || folder.kind !== 'folder' || folder.trashed) return { ok: false, error: 'not-found' };
      let created: string | undefined;
      const error = await runMove(transferId, async (signal, onProgress) => {
        created = await deps.cloud().createFolder(folder.name);
        const items = (readTree(container)?.nodes || [])
          .filter((n) => n.parent === node && !n.trashed)
          .map((n) => ({ id: n.id, name: n.name }));
        return moveNodes({
          from: container, items, to: created, wrapper: node, signal, onProgress,
        });
      });
      return error || !created ? { ok: false, error: error || 'rejected' } : { ok: true, container: created };
    },

    async parvaneCloudUsage(): Promise<CloudUsage | undefined> {
      return fetchUsage().catch(() => undefined);
    },

    // ── ссылки для людей без аккаунта (spec 022) ─────────────────────────────

    /** Создать ссылку на файл либо папку; ход «N из M» — событием `parvane-cloud-link`. */
    async parvaneCloudLinkCreate({
      container, node, name, ttlDays, transferId,
    }: {
      container: string; node?: string; name?: string; ttlDays: number; transferId: string;
    }): Promise<CloudResult<{ link: CloudLinkInfo }>> {
      const abort = new AbortController();
      links.set(transferId, abort);
      try {
        const link = await createLink({
          container,
          node,
          name,
          ttlDays,
          signal: abort.signal,
          onProgress: (done, total) => {
            if (typeof window === 'undefined') return;
            const detail: CloudLinkProgress = { id: transferId, done, total };
            window.dispatchEvent(new CustomEvent('parvane-cloud-link', { detail }));
          },
        });
        return { ok: true, link };
      } catch (e) {
        if (e instanceof CloudAbortError) return { ok: false, error: 'rejected' };
        deps.log(`облако: ссылка не создана: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      } finally {
        links.delete(transferId);
      }
    },

    parvaneCloudLinkCancel({ transferId }: { transferId: string }) {
      links.get(transferId)?.abort();
      return Promise.resolve(true);
    },

    /** Свои ссылки: названия и адреса — из записей владельца. */
    async parvaneCloudLinks(): Promise<CloudResult<{ links: CloudLinkInfo[] }>> {
      try {
        const got = await deps.transport().blobCall<{ links?: LinkInfoReply[] }>('cloud.link.list', {});
        const keys = driveKeys();
        const list = await Promise.all((got.links || []).map((reply) => readLink(reply, keys)));
        return {
          ok: true,
          links: list.filter((l): l is CloudLinkInfo => Boolean(l)).sort((a, b) => b.createdAt - a.createdAt),
        };
      } catch (e) {
        deps.log(`облако: список ссылок не получен: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Отозвать ссылку: копии удаляются, место возвращается. */
    async parvaneCloudLinkRevoke({ linkId }: { linkId: string }): Promise<CloudResult> {
      try {
        await revokeLink(linkId);
        return { ok: true };
      } catch (e) {
        deps.log(`облако: ссылка не отозвана: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Новый срок действующей либо истёкшей ссылки (0 — без срока). */
    async parvaneCloudLinkExtend(
      { linkId, ttlDays }: { linkId: string; ttlDays: number },
    ): Promise<CloudResult<{ expiresAt: number }>> {
      try {
        const got = await withRetry(() => deps.transport().blobCall<{
          expiresAt?: string | number; expires_at?: string | number;
        }>('cloud.link.extend', { link_id: linkId, ttl_days: ttlDays }));
        return { ok: true, expiresAt: Number(got.expiresAt || got.expires_at || 0) };
      } catch (e) {
        deps.log(`облако: срок ссылки не изменён: ${String(e)}`);
        return { ok: false, error: errorOf(e) };
      }
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

    /** Файлы облака, встроенные в статью (этап 6 плана 15 окт 2026): копии блобов в медиа чатов со своими
     * секретами доступа; `name` — имя файла в тексте статьи. Нет файла — пропускается. */
    async parvaneCloudArticleMedia({ container, items }: {
      container: string; items: { node: string; name: string }[];
    }): Promise<CloudResult<{ media: WireMessageContent[] }>> {
      const media: WireMessageContent[] = [];
      try {
        for (const item of items) {
          const found = findNode(container, item.node);
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
          media.push({
            kind: 'file',
            file_id: copyId,
            file_key: found.blob.key,
            file_nonce: found.blob.nonce,
            capability: fresh.capability,
            mime: found.mime || 'application/octet-stream',
            size_bytes: found.size,
            filename: item.name,
          });
        }
        return { ok: true, media };
      } catch (e) {
        deps.log(`облако: файлы статьи не скопированы: ${String(e)}`);
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
        await removeShared(container);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },

    /** Сделать свою совместную папку обычной: содержимое — в новую папку личного
     * диска (`name`), участники теряют доступ, контейнер удаляется. */
    async parvaneCloudUnshareFolder({ container, name, transferId }: {
      container: string; name: string; transferId: string;
    }): Promise<CloudResult> {
      const error = await runMove(transferId, async (signal, onProgress) => {
        const folder = newCloudNodeId();
        const root = await deps.cloud().apply('root', [{
          op: 'create', id: folder, kind: 'folder', name,
        }]);
        const items = (readTree(container)?.nodes || [])
          .filter((n) => !n.parent && !n.trashed)
          .map((n) => ({ id: n.id, name: n.name }));
        const total = await moveNodes({
          from: container, items, to: root, parent: folder, signal, onProgress,
        });
        await removeShared(container);
        return total;
      });
      return error ? { ok: false, error } : { ok: true };
    },
  };
}

export type CloudDrive = ReturnType<typeof createCloudDrive>;
