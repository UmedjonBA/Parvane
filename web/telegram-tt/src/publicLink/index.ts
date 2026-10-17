import type { CloudBlobTransport } from '../api/parvane/cloudBlobs';
import type { LinkManifest, LinkManifestFile, LinkTreeNode } from '../api/parvane/cloudLinks';

import { decryptBlob } from '../api/parvane/blobcrypt';
import {
  CloudAbortError, createBlobSink, createFileSink, createLimiter, downloadCloudBlob,
} from '../api/parvane/cloudBlobs';
import {
  buildLinkTree, isLinkDir, isLinkId, openManifest, parseLinkKey,
} from '../api/parvane/cloudLinks';
import { V2Error } from '../api/parvane/v2/transport';
import { createLinkClient } from './client';
import {
  filesText, fill, pickLang, sizeText, stringsFor,
} from './strings';
import { canZip, createZipWriter } from './zip';

import './style.css';

// Parvane (spec 022): публичная страница ссылки на файлы облака — для людей
// без аккаунта. Отдельный лёгкий вход сборки (`s.html`): без приложения, без
// движка (WASM) и без service worker; в хранилища браузера ничего не пишет.
// Идентификатор ссылки — в `?id=`, ключ — во фрагменте `#k=`: серверу уходят
// только `link_id` и `file_id`, список и файлы расшифровываются здесь.

type PageState = 'loading' | 'ready' | 'incomplete' | 'not-found' | 'expired' | 'rate-limited' | 'offline' | 'error';
type SavePicker = (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
type Tone = 'folder' | 'image' | 'text' | 'file';

const GATEWAY_URL_STORAGE_KEY = 'parvane:gateway';
const ARE_DIAG_HOOKS_ENABLED = import.meta.env.VITE_PARVANE_DIAG_HOOKS === '1';
// Файлы крупнее сохраняются сразу на диск (где браузер умеет), а не через память
const STREAM_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MEMORY_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
const OBJECT_URL_LIFETIME_MS = 60000;
// Миниатюры качаются, когда строка видна, не больше двух разом: у ссылки предел обращений в минуту
const THUMB_PARALLEL = 2;
const IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml',
]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/x-yaml', 'application/yaml']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'canvas', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'html', 'htm', 'css', 'js', 'ts', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'sh', 'sql', 'srt', 'vtt',
]);
// Тип скачанного Blob: всё, что браузер мог бы исполнить как страницу этого сайта, уходит байтами
const SAFE_DOWNLOAD_MIME = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|(?:audio|video)\/[\w.+-]+|application\/pdf)$/;

const lang = pickLang(navigator.language);
const strings = stringsFor(lang);
const page = document.getElementById('page')!;
const statusBox = document.getElementById('status')!;
const contentBox = document.getElementById('content')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string, attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function getGatewayUrl() {
  const isSecurePage = window.location.protocol === 'https:';
  // Переопределение адреса — только в диагностической сборке (сценарии): как в приложении,
  // на https-странице допустим лишь wss
  if (ARE_DIAG_HOOKS_ENABLED) {
    try {
      const override = localStorage.getItem(GATEWAY_URL_STORAGE_KEY);
      if (override && (!isSecurePage || override.startsWith('wss://'))) return override;
    } catch {
      // Хранилище недоступно — адрес по умолчанию
    }
  }
  // Скрытый сервис Tor (spec 025): на `.onion` gateway — на том же адресе по `/ws`
  if (isSecurePage) return `wss://${window.location.host}/ws`;
  if (window.location.hostname.endsWith('.onion')) return `ws://${window.location.host}/ws`;
  return `ws://${window.location.hostname}:9222`;
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function imageMimeOf(file: LinkManifestFile) {
  if (IMAGE_MIMES.has(file.mime)) return file.mime;
  return IMAGE_EXTENSIONS[extensionOf(file.path)];
}

function isText(file: LinkManifestFile) {
  return file.mime.startsWith('text/') || TEXT_MIMES.has(file.mime) || TEXT_EXTENSIONS.has(extensionOf(file.path));
}

function previewKind(file: LinkManifestFile): 'image' | 'text' | undefined {
  if (imageMimeOf(file)) return file.size <= IMAGE_PREVIEW_MAX_BYTES ? 'image' : undefined;
  if (isText(file)) return file.size <= TEXT_PREVIEW_MAX_BYTES ? 'text' : undefined;
  return undefined;
}

function toneOf(file: LinkManifestFile): Tone {
  return imageMimeOf(file) ? 'image' : isText(file) ? 'text' : 'file';
}

function setState(state: PageState) {
  page.dataset.state = state;
}

function showStatus(state: PageState, title: string, text?: string, onRetry?: () => void) {
  setState(state);
  contentBox.hidden = true;
  contentBox.replaceChildren();
  statusBox.hidden = false;
  statusBox.replaceChildren(el('h1', 'status-title', title));
  if (text) statusBox.append(el('p', 'status-text', text));
  if (onRetry) {
    const button = el('button', 'btn acc', strings.retry, { type: 'button' });
    button.addEventListener('click', onRetry);
    statusBox.append(button);
  }
}

function errorCode(e: unknown) {
  return e instanceof V2Error ? e.code : '';
}

// ── скачивание и просмотр ────────────────────────────────────────────────────

function makeTransport(linkId: string, file: LinkManifestFile): CloudBlobTransport {
  const client = createLinkClient(getGatewayUrl(), APP_VERSION);
  return {
    blobCall: () => Promise.reject(new V2Error('ERROR_CODE_FORBIDDEN')),
    downloadBlobCap: async (fileId, _capability, firstChunk, chunkCount) => {
      const got = await client.download(linkId, fileId, firstChunk, chunkCount);
      // Сверка с зашифрованным списком: сервер не может подсунуть блоб другого размера
      if (got.size !== file.blobSize || got.chunks !== file.chunks) throw new V2Error('ERROR_CODE_INVALID');
      return got;
    },
  };
}

const thumbLimiter = createLimiter(THUMB_PARALLEL);
const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach(({ isIntersecting, target }) => {
    if (!isIntersecting) return;
    thumbObserver!.unobserve(target);
    (target as HTMLElement & { loadThumb?: () => void }).loadThumb?.();
  });
}, { rootMargin: '200px' }) : undefined;

// Миниатюра картинки в плитке строки: копия в ссылке, ключ — ключ файла, nonce — свой. Не вышло — плитка-значок
function attachThumb(tile: HTMLElement, linkId: string, file: LinkManifestFile) {
  const { thumb } = file;
  if (!thumb) return;
  const load = () => thumbLimiter(async () => {
    const got = await createLinkClient(getGatewayUrl(), APP_VERSION).download(linkId, thumb.fileId, 0, 1);
    const cipher = got.parts.get(0);
    if (got.size !== thumb.blobSize || !cipher) return;
    const plain = await decryptBlob(cipher, file.key, thumb.nonce);
    if (!plain) return;
    const image = el('img', 'thumb', undefined, {
      alt: '', src: URL.createObjectURL(new Blob([plain as BlobPart], { type: 'image/jpeg' })),
    });
    image.addEventListener('error', () => image.remove());
    tile.append(image);
    tile.classList.add('has-thumb');
  }).catch(() => undefined);
  if (!thumbObserver) {
    void load();
    return;
  }
  (tile as HTMLElement & { loadThumb?: () => void }).loadThumb = () => void load();
  thumbObserver.observe(tile);
}

function fileErrorText(e: unknown) {
  const code = errorCode(e);
  if (code === 'ERROR_CODE_INVALID') return strings.integrityError;
  if (code === 'ERROR_CODE_NOT_FOUND' || code === 'ERROR_CODE_EXPIRED') return strings.fileGone;
  if (code === 'ERROR_CODE_RATE_LIMITED') return strings.fileRate;
  return strings.fileOffline;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = el('a', undefined, undefined, { href: url, download: name });
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

function renderFileRow(linkId: string, node: LinkTreeNode, file: LinkManifestFile) {
  const row = el('li', 'item file', undefined, { 'data-file-path': file.path, 'data-file-state': 'idle' });
  const line = el('div', 'line');
  const tile = el('span', `tile tone-${toneOf(file)}`, undefined, { 'aria-hidden': 'true' });
  attachThumb(tile, linkId, file);
  line.append(
    tile,
    el('span', 'name', node.name, { dir: 'auto' }),
    el('span', 'meta', sizeText(strings, file.size)),
  );
  const actions = el('span', 'actions');
  const kind = previewKind(file);
  const viewButton = kind ? el('button', 'btn ghost', strings.view, { type: 'button', 'data-view': '' }) : undefined;
  const downloadButton = el('button', 'btn acc', strings.download, { type: 'button', 'data-download': '' });
  if (viewButton) actions.append(viewButton);
  actions.append(downloadButton);
  line.append(actions);

  const progress = el('div', 'progress');
  progress.hidden = true;
  const bar = el('div', 'progress-bar');
  const barFill = el('div', 'progress-fill');
  bar.append(barFill);
  const progressText = el('span', 'progress-text', undefined, { role: 'status' });
  const cancelButton = el('button', 'btn ghost small', strings.cancel, { type: 'button' });
  progress.append(bar, progressText, cancelButton);
  const note = el('div', 'note', undefined, { role: 'alert' });
  note.hidden = true;
  const preview = el('div', 'preview', undefined, { 'data-preview': '' });
  preview.hidden = true;
  row.append(line, progress, note, preview);

  let abort: AbortController | undefined;
  let previewUrl: string | undefined;

  const setBusy = (isBusy: boolean) => {
    downloadButton.disabled = isBusy;
    if (viewButton) viewButton.disabled = isBusy;
    progress.hidden = !isBusy;
  };
  const showNote = (text?: string, isError = true) => {
    note.hidden = !text;
    note.textContent = text || '';
    note.classList.toggle('ok', !isError);
  };
  const onProgress = (template: string) => (done: number, total: number) => {
    const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    barFill.style.transform = `scaleX(${percent / 100})`;
    progressText.textContent = fill(template, { percent });
  };

  /** Скачать и расшифровать файл; содержимое — в `handle` либо в память. */
  async function fetchFile(template: string, mime: string, handle?: FileSystemFileHandle) {
    abort = new AbortController();
    setBusy(true);
    showNote();
    row.dataset.fileState = 'loading';
    const report = onProgress(template);
    report(0, file.size);
    try {
      const memory = handle ? undefined : createBlobSink(mime);
      const sink = handle ? await createFileSink(handle) : memory!.sink;
      await downloadCloudBlob(makeTransport(linkId, file), {
        fileId: file.fileId, key: file.key, nonce: file.nonce, capability: '', size: file.size, chunks: file.chunks,
      }, sink, { signal: abort.signal, onProgress: report });
      row.dataset.fileState = 'done';
      return { blob: memory?.getBlob() };
    } catch (e) {
      const isCanceled = e instanceof CloudAbortError;
      row.dataset.fileState = isCanceled ? 'idle' : 'failed';
      if (!isCanceled) {
        row.dataset.fileError = errorCode(e) === 'ERROR_CODE_INVALID' ? 'integrity' : 'failed';
        showNote(fileErrorText(e));
      }
      return undefined;
    } finally {
      abort = undefined;
      setBusy(false);
    }
  }

  cancelButton.addEventListener('click', () => abort?.abort());

  downloadButton.addEventListener('click', async () => {
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let handle: FileSystemFileHandle | undefined;
    if (picker && file.size > STREAM_DOWNLOAD_BYTES) {
      try {
        handle = await picker({ suggestedName: node.name });
      } catch {
        // Окно выбора файла закрыто
        return;
      }
    }
    if (!handle && file.size > MEMORY_DOWNLOAD_MAX_BYTES) {
      row.dataset.fileState = 'failed';
      row.dataset.fileError = 'too-large';
      showNote(strings.tooLargeForBrowser);
      return;
    }
    const mime = SAFE_DOWNLOAD_MIME.test(file.mime) ? file.mime : 'application/octet-stream';
    const got = await fetchFile(strings.downloading, mime, handle);
    if (!got) return;
    if (got.blob) saveBlob(got.blob, node.name);
    else showNote(strings.saved, false);
  });

  viewButton?.addEventListener('click', async () => {
    if (!preview.hidden) {
      preview.hidden = true;
      preview.replaceChildren();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = undefined;
      viewButton.textContent = strings.view;
      return;
    }
    const imageMime = kind === 'image' ? imageMimeOf(file) : undefined;
    const got = await fetchFile(strings.decrypting, imageMime || 'text/plain');
    if (!got?.blob) return;
    if (imageMime) {
      // Картинка показывается только тегом <img>: и SVG в нём ничего не исполняет
      previewUrl = URL.createObjectURL(got.blob);
      const image = el('img', 'preview-image', undefined, { alt: node.name, src: previewUrl });
      image.addEventListener('error', () => {
        preview.replaceChildren(el('div', 'note', strings.previewFailed));
      });
      preview.replaceChildren(image);
    } else {
      preview.replaceChildren(el('pre', 'preview-text', await got.blob.text(), { dir: 'auto' }));
    }
    preview.hidden = false;
    viewButton.textContent = strings.hide;
  });

  return row;
}

function renderTree(linkId: string, nodes: LinkTreeNode[], isNested: boolean) {
  const list = el('ul', isNested ? 'tree nested' : 'tree', undefined, { role: isNested ? 'group' : 'list' });
  nodes.forEach((node) => {
    if (node.file) {
      list.append(renderFileRow(linkId, node, node.file));
      return;
    }
    const row = el('li', 'item dir', undefined, { 'data-dir-path': node.path });
    const toggle = el('button', 'line dir-toggle', undefined, { type: 'button', 'aria-expanded': 'true' });
    toggle.append(
      el('span', 'tile tone-folder', undefined, { 'aria-hidden': 'true' }),
      el('span', 'name', node.name, { dir: 'auto' }),
      el('span', 'meta', node.children.length ? filesText(lang, countFiles(node)) : strings.emptyFolder),
      el('span', 'chevron', undefined, { 'aria-hidden': 'true' }),
    );
    const inner = renderTree(linkId, node.children, true);
    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      inner.hidden = isOpen;
    });
    row.append(toggle, inner);
    list.append(row);
  });
  return list;
}

function countFiles(node: LinkTreeNode): number {
  return node.file ? 1 : node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

// «Скачать всё»: ZIP пишется потоком — файлы по одному, каждый прямо в архив (на диск, где браузер умеет)
function renderDownloadAll(linkId: string, manifest: LinkManifest, files: LinkManifestFile[]) {
  const box = el('div', 'download-all');
  const button = el('button', 'btn acc', strings.downloadAll, { type: 'button', 'data-download-all': '' });
  const progress = el('div', 'progress');
  progress.hidden = true;
  const bar = el('div', 'progress-bar');
  const barFill = el('div', 'progress-fill');
  bar.append(barFill);
  const progressText = el('span', 'progress-text', undefined, { role: 'status' });
  const cancelButton = el('button', 'btn ghost small', strings.cancel, { type: 'button' });
  progress.append(bar, progressText, cancelButton);
  const note = el('div', 'note', undefined, { role: 'alert' });
  note.hidden = true;
  box.append(button, progress, note);
  let abort: AbortController | undefined;

  const showNote = (text?: string, isError = true) => {
    note.hidden = !text;
    note.textContent = text || '';
    note.classList.toggle('ok', !isError);
  };
  const report = (done: number, total: number) => {
    const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 100;
    barFill.style.transform = `scaleX(${percent / 100})`;
    progressText.textContent = fill(strings.downloadingAll, { percent });
  };
  const dirs = manifest.items.filter(isLinkDir).map(({ path }) => path);
  const archiveName = `${manifest.name}.zip`;

  cancelButton.addEventListener('click', () => abort?.abort());
  button.addEventListener('click', async () => {
    showNote();
    const entries = [
      ...files.map(({ path, size }) => ({ name: path, size })),
      ...dirs.map((dir) => ({ name: dir, size: 0 })),
    ];
    if (!canZip(entries)) {
      box.dataset.downloadState = 'failed';
      showNote(strings.archiveTooLarge);
      return;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let handle: FileSystemFileHandle | undefined;
    if (picker && total > STREAM_DOWNLOAD_BYTES) {
      try {
        handle = await picker({ suggestedName: archiveName });
      } catch {
        return;
      }
    }
    if (!handle && total > MEMORY_DOWNLOAD_MAX_BYTES) {
      box.dataset.downloadState = 'failed';
      showNote(strings.tooLargeForBrowser);
      return;
    }
    abort = new AbortController();
    button.disabled = true;
    progress.hidden = false;
    box.dataset.downloadState = 'loading';
    report(0, total);
    const memory = handle ? undefined : createBlobSink('application/zip');
    try {
      const zip = createZipWriter(handle ? await createFileSink(handle) : memory!.sink);
      for (const dir of dirs) await zip.addDir(dir);
      let base = 0;
      for (const file of files) {
        await downloadCloudBlob(makeTransport(linkId, file), {
          fileId: file.fileId, key: file.key, nonce: file.nonce, capability: '', size: file.size, chunks: file.chunks,
        }, await zip.file(file.path), {
          signal: abort.signal, onProgress: (done) => report(base + done, total),
        });
        base += file.size;
      }
      await zip.finish();
      box.dataset.downloadState = 'done';
      if (memory) saveBlob(memory.getBlob()!, archiveName);
      else showNote(strings.saved, false);
    } catch (e) {
      const isCanceled = e instanceof CloudAbortError;
      box.dataset.downloadState = isCanceled ? 'idle' : 'failed';
      if (!isCanceled) showNote(fileErrorText(e));
    } finally {
      abort = undefined;
      button.disabled = false;
      progress.hidden = true;
    }
  });
  return box;
}

function showManifest(linkId: string, manifest: LinkManifest, expiresAt: number) {
  const files = manifest.items.filter((item): item is LinkManifestFile => !isLinkDir(item));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const isFolder = manifest.kind === 'folder';
  document.title = `${manifest.name} — Parvane`;

  const head = el('div', 'head');
  const titles = el('div', 'titles');
  const facts = [
    isFolder ? filesText(lang, files.length) : undefined,
    sizeText(strings, totalBytes),
    expiresAt ? fill(strings.validUntil, {
      date: new Date(expiresAt * 1000).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' }),
    }) : undefined,
  ].filter(Boolean).join(' · ');
  titles.append(
    el('h1', 'title', manifest.name, { dir: 'auto', 'data-link-name': '' }),
    el('div', 'facts', facts, { 'data-link-facts': '' }),
  );
  head.append(
    el('span', `tile big tone-${isFolder ? 'folder' : files[0] ? toneOf(files[0]) : 'file'}`, undefined, {
      'aria-hidden': 'true',
    }),
    titles,
  );

  const tree = buildLinkTree(manifest.items);
  contentBox.replaceChildren(
    el('p', 'lead', isFolder ? strings.sharedFolder : strings.sharedFile),
    head,
    ...(isFolder && files.length > 1 ? [renderDownloadAll(linkId, manifest, files)] : []),
    tree.length ? renderTree(linkId, tree, false) : el('p', 'empty', strings.emptyFolder),
  );
  statusBox.hidden = true;
  contentBox.hidden = false;
  contentBox.dataset.linkKind = manifest.kind;
  contentBox.dataset.linkFiles = String(files.length);
  setState('ready');
}

async function openLink() {
  const linkId = new URLSearchParams(window.location.search).get('id') || '';
  const linkKey = parseLinkKey(window.location.hash);
  // Без ключа серверу не уходит ничего: показать было бы всё равно нечего
  if (!isLinkId(linkId) || !linkKey) {
    showStatus('incomplete', strings.incompleteTitle, strings.incompleteText);
    return;
  }
  showStatus('loading', strings.loading);
  try {
    const got = await createLinkClient(getGatewayUrl(), APP_VERSION).get(linkId);
    if (got.expired) {
      showStatus('expired', strings.expiredTitle, strings.expiredText);
      return;
    }
    const manifest = await openManifest(got.manifest, linkKey, linkId);
    if (!manifest) {
      // Ключ не подошёл: названий без него нет
      showStatus('incomplete', strings.incompleteTitle, strings.incompleteText);
      return;
    }
    showManifest(linkId, manifest, got.expiresAt);
  } catch (e) {
    const code = errorCode(e);
    if (code === 'ERROR_CODE_NOT_FOUND') {
      showStatus('not-found', strings.notFoundTitle, strings.notFoundText);
    } else if (code === 'ERROR_CODE_EXPIRED') {
      showStatus('expired', strings.expiredTitle, strings.expiredText);
    } else if (code === 'ERROR_CODE_RATE_LIMITED') {
      showStatus('rate-limited', strings.rateTitle, strings.rateText, openLink);
    } else if (code === 'ERROR_CODE_UNAVAILABLE') {
      showStatus('offline', strings.offlineTitle, strings.offlineText, openLink);
    } else {
      showStatus('error', strings.errorTitle, strings.errorText, openLink);
    }
  }
}

document.documentElement.lang = lang;
document.title = strings.pageTitle;
document.getElementById('foot-note')!.textContent = strings.footNote;
document.getElementById('foot-key')!.textContent = strings.footKey;
// Другой ключ в адресе той же вкладки — открыть заново
window.addEventListener('hashchange', () => void openLink());
void openLink();
