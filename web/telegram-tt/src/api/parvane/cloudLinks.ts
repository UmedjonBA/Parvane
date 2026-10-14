import { decryptBlob, encryptBlobWithKey } from './blobcrypt';

// Parvane (spec 022): ссылка на файлы облака для людей без аккаунта — чистая
// логика, общая для приложения и публичной страницы (`src/publicLink`). Модуль
// зависит только от `blobcrypt.ts` (WebCrypto): ни движка, ни сессии.
//   - список ссылки (manifest): JSON, зашифрованный PVB2 ключом ссылки; ключ
//     живёт только во фрагменте адреса `#k=` и серверу не уходит;
//   - запись владельца: название и ключ ссылки под ключом личного диска — по
//     ней свои устройства показывают «Мои ссылки» и собирают полный адрес;
//   - копии файлов сохраняют ключ и nonce исходного блоба (они случайные на
//     блоб и лежат в зашифрованном списке).
// Форматы — `specs/022-public-links/contracts/links.md`.

export const LINK_MAX_FILES = 500;
// Миниатюр картинок в ссылке не больше: каждая — отдельная копия в пределе `LINK_MAX_FILES` блобов ссылки и
// отдельное обращение страницы (сервер пускает к ссылке 120 обращений в минуту)
export const LINK_MAX_THUMBS = 60;
export const LINK_MANIFEST_MAX_BYTES = 1024 * 1024;
export const LINK_OWNER_RECORD_MAX_BYTES = 4096;
export const LINK_TTL_DAYS = [1, 7, 30, 0] as const;
export const LINK_DEFAULT_TTL_DAYS = 7;
export const LINK_KEY_BYTES = 32;

const MANIFEST_VERSION = 1;
const MANIFEST_NONCE_LABEL = 'parvane-link-manifest';
const OWNER_NONCE_LABEL = 'parvane-link-owner';
const NONCE_BYTES = 12;
const EPOCH_BYTES = 4;
const LINK_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const LINK_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
// Служебные файлы разделов (метки хранилища заметок) в ссылку не идут
const SERVICE_PREFIX = '.parvane-';
// eslint-disable-next-line no-control-regex
const BAD_PATH_PART = /[/\\\u0000-\u001f\u007f]/;

export type LinkTtlDays = typeof LINK_TTL_DAYS[number];
export type LinkKind = 'file' | 'folder';

export type LinkManifestDir = { path: string; dir: true };
/** Миниатюра картинки: копия блоба миниатюры, зашифрована ключом файла со своим nonce; один чанк. */
export type LinkManifestThumb = { fileId: string; nonce: string; blobSize: number };
export type LinkManifestFile = {
  path: string;
  /** Открытый размер файла. */
  size: number;
  mime: string;
  /** Блоб-копия ссылки. */
  fileId: string;
  /** Ключ и nonce содержимого, base64. */
  key: string;
  nonce: string;
  /** Число чанков сервера и размер шифртекста — для сверки при скачивании. */
  chunks: number;
  blobSize: number;
  thumb?: LinkManifestThumb;
};
export type LinkManifestItem = LinkManifestDir | LinkManifestFile;
export type LinkManifest = {
  v: number;
  name: string;
  kind: LinkKind;
  /** Создана, unix-секунды. */
  created: number;
  items: LinkManifestItem[];
};

export type LinkOwnerRecord = {
  name: string;
  kind: LinkKind;
  /** Ключ ссылки, base64url. */
  key: string;
  /** Эпоха ключа личного диска, которым запись зашифрована. */
  epoch: number;
  /** Расширение web: исходный узел — по нему шторка узла находит свою ссылку. */
  source?: { container: string; node: string };
};

/** Узел дерева облака в объёме, нужном плану ссылки. */
export type LinkSourceNode = {
  id: string;
  kind: 'folder' | 'file';
  parent?: string;
  name: string;
  size: number;
  mime: string;
  trashed: boolean;
  blob?: {
    fileId: string; key: string; nonce: string; capability: string; size: number; chunks: number; mime: string;
  };
  /** Миниатюра картинки (шифруется ключом файла). */
  thumb?: { fileId: string; nonce: string; capability: string };
};

export type LinkPlanFile = { path: string; node: LinkSourceNode };
export type LinkPlan = {
  name: string;
  kind: LinkKind;
  /** Папки внутри ссылки (пути относительно её корня), от корня вглубь. */
  dirs: string[];
  files: LinkPlanFile[];
  /** Сумма открытых размеров файлов. */
  bytes: number;
};

export type LinkPlanError = 'not-found' | 'too-many';

export function isLinkDir(item: LinkManifestItem): item is LinkManifestDir {
  return (item as LinkManifestDir).dir === true;
}

// ── base64 ───────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

export function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (и обычный base64) → байты; негодная строка — undefined. */
export function base64UrlToBytes(data: string): Uint8Array | undefined {
  try {
    const normal = data.replace(/-/g, '+').replace(/_/g, '/');
    return base64ToBytes(normal + '='.repeat((4 - (normal.length % 4)) % 4));
  } catch {
    return undefined;
  }
}

// ── адрес ────────────────────────────────────────────────────────────────────

export function isLinkId(value: string) {
  return LINK_ID_RE.test(value);
}

export function newLinkKey() {
  return crypto.getRandomValues(new Uint8Array(LINK_KEY_BYTES));
}

/** `https://<сервер>/s/<link_id>#k=<ключ>`; ключ остаётся во фрагменте. */
export function buildLinkUrl(origin: string, linkId: string, keyB64Url: string) {
  return `${origin.replace(/\/+$/, '')}/s/${linkId}#k=${keyB64Url}`;
}

/** Ключ ссылки из фрагмента адреса (`#k=…`): 32 байта либо undefined. */
export function parseLinkKey(hash: string): Uint8Array | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('k') || '';
  if (!LINK_KEY_RE.test(value)) return undefined;
  const bytes = base64UrlToBytes(value);
  return bytes?.length === LINK_KEY_BYTES ? bytes : undefined;
}

// ── план: что войдёт в ссылку ────────────────────────────────────────────────

/**
 * Собрать содержимое ссылки из узла дерева: файл либо папка со всем вложенным.
 * Корзина и служебные файлы не входят; предел числа файлов проверяется здесь,
 * до первого запроса к серверу. `nodeId` не задан — весь контейнер (совместная
 * папка целиком) под названием `rootName`.
 */
export function buildLinkPlan(
  nodes: LinkSourceNode[], nodeId: string | undefined, rootName = '',
): LinkPlan | { error: LinkPlanError } {
  const top: LinkSourceNode | undefined = nodeId ? nodes.find((n) => n.id === nodeId) : {
    id: '', kind: 'folder', name: rootName, size: 0, mime: '', trashed: false,
  };
  if (!top || top.trashed || !top.name) return { error: 'not-found' };
  if (top.kind === 'file') {
    if (!top.blob) return { error: 'not-found' };
    return {
      name: top.name, kind: 'file', dirs: [], files: [{ path: top.name, node: top }], bytes: top.blob.size,
    };
  }
  const children = new Map<string, LinkSourceNode[]>();
  nodes.forEach((n) => {
    // Верхний уровень контейнера лежит под ключом '' — это и есть «узел» всей папки
    if (n.trashed) return;
    const parent = n.parent || '';
    children.set(parent, [...(children.get(parent) || []), n]);
  });
  const dirs: string[] = [];
  const files: LinkPlanFile[] = [];
  const queue: { id: string; prefix: string }[] = [{ id: top.id, prefix: '' }];
  const seen = new Set([top.id]);
  for (let i = 0; i < queue.length; i++) {
    const { id, prefix } = queue[i];
    const list = (children.get(id) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const child of list) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const path = prefix + child.name;
      if (child.kind === 'folder') {
        dirs.push(path);
        queue.push({ id: child.id, prefix: `${path}/` });
      } else if (child.blob && !child.name.startsWith(SERVICE_PREFIX)) {
        files.push({ path, node: child });
        if (files.length > LINK_MAX_FILES) return { error: 'too-many' };
      }
    }
  }
  return {
    name: top.name, kind: 'folder', dirs, files, bytes: files.reduce((sum, f) => sum + (f.node.blob?.size || 0), 0),
  };
}

/** Список ссылки: папки и файлы плана с указателями на блобы-копии. */
export function buildManifest(
  plan: LinkPlan,
  copies: Map<string, { fileId: string; blobSize: number; chunks: number; thumb?: LinkManifestThumb }>,
  createdSec: number,
): LinkManifest {
  const items: LinkManifestItem[] = plan.dirs.map((path) => ({ path, dir: true }));
  plan.files.forEach(({ path, node }) => {
    const copy = copies.get(node.id);
    const blob = node.blob;
    if (!copy || !blob) throw new Error('cloud link: file without a copy');
    items.push({
      path,
      size: blob.size,
      mime: node.mime || blob.mime || 'application/octet-stream',
      fileId: copy.fileId,
      key: blob.key,
      nonce: blob.nonce,
      chunks: copy.chunks,
      blobSize: copy.blobSize,
      ...(copy.thumb && { thumb: copy.thumb }),
    });
  });
  return {
    v: MANIFEST_VERSION, name: plan.name, kind: plan.kind, created: createdSec, items,
  };
}

// ── шифрование списка и записи владельца ─────────────────────────────────────

async function labelNonce(label: string, linkId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label + linkId));
  return new Uint8Array(digest).slice(0, NONCE_BYTES);
}

export async function sealManifest(manifest: LinkManifest, linkKey: Uint8Array, linkId: string) {
  const plain = new TextEncoder().encode(JSON.stringify(manifest));
  return encryptBlobWithKey(plain, linkKey, await labelNonce(MANIFEST_NONCE_LABEL, linkId));
}

function isSafePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path) return false;
  return path.split('/').every((part) => part && part !== '.' && part !== '..' && !BAD_PATH_PART.test(part));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Негодная миниатюра не портит список: файл просто остаётся без неё
function isThumb(value: unknown): value is LinkManifestThumb {
  const thumb = value as Partial<LinkManifestThumb> | undefined;
  return Boolean(thumb) && typeof thumb === 'object' && typeof thumb.fileId === 'string' && Boolean(thumb.fileId)
    && typeof thumb.nonce === 'string' && isCount(thumb.blobSize) && thumb.blobSize > 0;
}

/** Разобрать открытый текст списка; всё, что не по контракту, — undefined. */
export function parseManifest(json: string): LinkManifest | undefined {
  let raw: Partial<LinkManifest> | undefined;
  try {
    raw = JSON.parse(json) as Partial<LinkManifest>;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || raw.v !== MANIFEST_VERSION) return undefined;
  if (typeof raw.name !== 'string' || !raw.name) return undefined;
  if (raw.kind !== 'file' && raw.kind !== 'folder') return undefined;
  if (!Array.isArray(raw.items)) return undefined;
  const items: LinkManifestItem[] = [];
  const paths = new Set<string>();
  let files = 0;
  let thumbs = 0;
  for (const entry of raw.items as Partial<LinkManifestFile & LinkManifestDir>[]) {
    if (!entry || typeof entry !== 'object' || !isSafePath(entry.path) || paths.has(entry.path)) return undefined;
    paths.add(entry.path);
    if (entry.dir === true) {
      items.push({ path: entry.path, dir: true });
      continue;
    }
    if (!isCount(entry.size) || !isCount(entry.blobSize) || !isCount(entry.chunks) || entry.chunks < 1) {
      return undefined;
    }
    if (typeof entry.fileId !== 'string' || !entry.fileId) return undefined;
    if (typeof entry.key !== 'string' || typeof entry.nonce !== 'string') return undefined;
    if (++files > LINK_MAX_FILES) return undefined;
    const thumb = thumbs < LINK_MAX_THUMBS && isThumb(entry.thumb)
      ? { fileId: entry.thumb.fileId, nonce: entry.thumb.nonce, blobSize: entry.thumb.blobSize }
      : undefined;
    if (thumb) thumbs += 1;
    items.push({
      path: entry.path,
      size: entry.size,
      mime: typeof entry.mime === 'string' ? entry.mime : 'application/octet-stream',
      fileId: entry.fileId,
      key: entry.key,
      nonce: entry.nonce,
      chunks: entry.chunks,
      blobSize: entry.blobSize,
      ...(thumb && { thumb }),
    });
  }
  return {
    v: MANIFEST_VERSION, name: raw.name, kind: raw.kind, created: isCount(raw.created) ? raw.created : 0, items,
  };
}

/** Расшифровать список ключом ссылки; чужой ключ либо подмена — undefined. */
export async function openManifest(cipher: Uint8Array, linkKey: Uint8Array, linkId: string) {
  if (linkKey.length !== LINK_KEY_BYTES) return undefined;
  const nonce = await labelNonce(MANIFEST_NONCE_LABEL, linkId);
  const plain = await decryptBlob(cipher, bytesToBase64(linkKey), bytesToBase64(nonce));
  return plain ? parseManifest(new TextDecoder().decode(plain)) : undefined;
}

/** Запись владельца на провод: `u32 BE эпоха | шифртекст` под ключом личного диска. */
export async function sealOwnerRecord(record: LinkOwnerRecord, driveKey: Uint8Array, linkId: string) {
  const plain = new TextEncoder().encode(JSON.stringify({ v: MANIFEST_VERSION, ...record }));
  const cipher = await encryptBlobWithKey(plain, driveKey, await labelNonce(OWNER_NONCE_LABEL, linkId));
  const out = new Uint8Array(EPOCH_BYTES + cipher.length);
  new DataView(out.buffer).setUint32(0, record.epoch, false);
  out.set(cipher, EPOCH_BYTES);
  return out;
}

/** Прочитать запись владельца; `driveKeys` — ключи личного диска по эпохам (base64). */
export async function openOwnerRecord(
  wire: Uint8Array, driveKeys: Map<number, string>, linkId: string,
): Promise<LinkOwnerRecord | undefined> {
  if (wire.length <= EPOCH_BYTES) return undefined;
  const epoch = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(0, false);
  const key = driveKeys.get(epoch);
  if (!key) return undefined;
  const nonce = await labelNonce(OWNER_NONCE_LABEL, linkId);
  const plain = await decryptBlob(wire.subarray(EPOCH_BYTES), key, bytesToBase64(nonce));
  if (!plain) return undefined;
  try {
    const raw = JSON.parse(new TextDecoder().decode(plain)) as Partial<LinkOwnerRecord> & { v?: number };
    if (raw.v !== MANIFEST_VERSION || typeof raw.name !== 'string' || typeof raw.key !== 'string') return undefined;
    if (raw.kind !== 'file' && raw.kind !== 'folder') return undefined;
    if (base64UrlToBytes(raw.key)?.length !== LINK_KEY_BYTES) return undefined;
    const source = raw.source && typeof raw.source.container === 'string' && typeof raw.source.node === 'string'
      ? { container: raw.source.container, node: raw.source.node } : undefined;
    return {
      name: raw.name, kind: raw.kind, key: raw.key, epoch, source,
    };
  } catch {
    return undefined;
  }
}

// ── дерево для показа ────────────────────────────────────────────────────────

export type LinkTreeNode = {
  name: string;
  path: string;
  file?: LinkManifestFile;
  children: LinkTreeNode[];
};

/** Дерево «папки и файлы» из плоского списка: папки первыми, по имени. */
export function buildLinkTree(items: LinkManifestItem[]): LinkTreeNode[] {
  const root: LinkTreeNode = { name: '', path: '', children: [] };
  const dirs = new Map<string, LinkTreeNode>([['', root]]);
  const dirOf = (path: string): LinkTreeNode => {
    const known = dirs.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const node: LinkTreeNode = { name: path.slice(cut + 1), path, children: [] };
    dirs.set(path, node);
    dirOf(cut < 0 ? '' : path.slice(0, cut)).children.push(node);
    return node;
  };
  items.forEach((item) => {
    if (isLinkDir(item)) {
      dirOf(item.path);
      return;
    }
    const cut = item.path.lastIndexOf('/');
    dirOf(cut < 0 ? '' : item.path.slice(0, cut)).children.push({
      name: item.path.slice(cut + 1), path: item.path, file: item, children: [],
    });
  });
  const sort = (node: LinkTreeNode) => {
    node.children.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

// ── очередь с ограниченным параллелизмом ─────────────────────────────────────

/** Выполнить `run` для каждого элемента, не больше `limit` одновременно; первая ошибка останавливает остальных. */
export async function runPool<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>) {
  let next = 0;
  let failure: { error: unknown } | undefined;
  async function worker() {
    while (next < items.length && !failure) {
      const index = next++;
      try {
        await run(items[index], index);
      } catch (error) {
        failure = failure || { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}
