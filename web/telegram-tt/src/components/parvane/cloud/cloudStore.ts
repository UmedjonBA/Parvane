import type {
  CloudDriveState, CloudErrorCode, CloudLinkInfo, CloudLinkProgress, CloudResult, CloudTransferEvent, CloudUsage,
} from '../../../api/parvane/cloudDrive';
import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';

import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import {
  type CloudNode, type CloudSort, freeName, namesIn, normalizeName, sizeOf, trashOf, usageOf,
} from './cloudModel';

// Parvane (spec 016): состояние раздела «Облако» — сигналы поверх контейнеров
// домена в движке. Экраны читают дерево (`parvaneCloudState`) и правят его
// операциями движка (`parvaneCloudApply`); сведённое дерево возвращается
// событием `parvane-cloud-changed`. Загрузки и скачивания идут в провайдере,
// ход — событиями `parvane-cloud-transfer`. Сортировка — настройка устройства.

export type CloudStatus = CloudDriveState['status'];
// Строки-папки в конце корня: принятые чужие папки, свои ссылки (spec 022) и корзина
export type CloudVirtualFolder = 'shared' | 'links' | 'trash';
// Место в едином списке: корень, строка-папка корня, контейнер (совместная папка), папка внутри
export type CloudPlace = { view?: CloudVirtualFolder; container?: string; folder?: string };
export type CloudPrefs = { sort: CloudSort };
export type CloudTransfer = {
  id: string;
  kind: 'upload' | 'download' | 'move';
  name: string;
  done: number;
  total: number;
  state: CloudTransferEvent['state'];
  error?: CloudErrorCode;
};
export type CloudNotice = { code: CloudErrorCode | 'saved' | 'sent'; at: number };

type UploadSpec = { container: string; parent?: string; name: string; file: File };

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

const CLOUD_EVENT = 'parvane-cloud-changed';
const TRANSFER_EVENT = 'parvane-cloud-transfer';
const LINK_EVENT = 'parvane-cloud-link';
const PREFS_KEY = 'parvane:cloud-prefs';
const LOAD_RETRY_MS = 1000;
const LOAD_ATTEMPTS = 60;
const LINKING_POLL_MS = 3000;
const NOTICE_HIDE_MS = 4000;
const DONE_HIDE_MS = 4000;
const USAGE_REFRESH_MS = 1600;
// Файлы крупнее сохраняются сразу на диск (если браузер умеет), а не через память
const STREAM_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_PREFS: CloudPrefs = { sort: { key: 'name', isDescending: false } };
const ROOT = 'root';

const [getCloudData, setCloudData] = createSignal<CloudDriveState | undefined>(undefined);
const [getIsCloudLoaded, setIsCloudLoaded] = createSignal(false);
const [getCloudStatus, setCloudStatus] = createSignal<CloudStatus>('loading');
const [getCloudPlace, setCloudPlaceSignal] = createSignal<CloudPlace>({});
const [getCloudTransfers, setCloudTransfersSignal] = createSignal<CloudTransfer[]>([]);
// Есть ли переносы вообще: на сам ход подписан только `CloudTransfers`, список файлов — на этот флаг
const [getHasCloudTransfers, setHasCloudTransfers] = createSignal(false);
const [getCloudUsage, setCloudUsage] = createSignal<CloudUsage | undefined>(undefined);
const [getCloudPrefs, setCloudPrefsSignal] = createSignal<CloudPrefs>(readPrefs());
const [getCloudNotice, setCloudNotice] = createSignal<CloudNotice | undefined>(undefined);
// Свои ссылки (не загружены — undefined) и ход создаваемой сейчас ссылки: «N из M» файлов
const [getCloudLinks, setCloudLinks] = createSignal<CloudLinkInfo[] | undefined>(undefined);
const [getCloudLinkProgress, setCloudLinkProgress] = createSignal<
  (CloudLinkProgress & { container: string; node: string }) | undefined
>(undefined);

export {
  getCloudData, getIsCloudLoaded, getCloudStatus, getCloudPlace, getCloudTransfers, getHasCloudTransfers, getCloudUsage,
  getCloudPrefs, getCloudNotice, getCloudLinks, getCloudLinkProgress,
};

function setCloudTransfers(list: CloudTransfer[]) {
  setCloudTransfersSignal(list);
  setHasCloudTransfers(list.length > 0);
}

let loadedUserId: string | undefined;
let loadPromise: Promise<void> | undefined;
let isListening = false;
let linkingTimer: number | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let usageTimer: ReturnType<typeof setTimeout> | undefined;
let transferSeq = 0;
const uploadSpecs = new Map<string, UploadSpec>();
const canceledLinks = new Set<string>();

function readPrefs(): CloudPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as Partial<CloudPrefs> | null;
    if (!saved) return DEFAULT_PREFS;
    return {
      sort: {
        key: saved.sort?.key === 'date' || saved.sort?.key === 'size' ? saved.sort.key : 'name',
        isDescending: Boolean(saved.sort?.isDescending),
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function setCloudPrefs(prefs: CloudPrefs) {
  setCloudPrefsSignal(prefs);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Настройка вида не сохранится — раздел работает и без неё
  }
}

export function setCloudPlace(place: CloudPlace) {
  setCloudPlaceSignal(place);
}

export function showCloudNotice(code: CloudNotice['code']) {
  setCloudNotice({ code, at: Date.now() });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setCloudNotice(undefined), NOTICE_HIDE_MS);
}

export function hideCloudNotice() {
  setCloudNotice(undefined);
}

function listen() {
  if (isListening || typeof window === 'undefined') return;
  isListening = true;
  window.addEventListener(CLOUD_EVENT, () => {
    void refreshCloud();
    // Занятое место меняется вместе с деревом (чужая загрузка, сборка стёртых блобов)
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = setTimeout(() => {
      void refreshCloudUsage();
    }, USAGE_REFRESH_MS);
  });
  window.addEventListener(TRANSFER_EVENT, (e) => {
    applyTransferEvent((e as CustomEvent<CloudTransferEvent>).detail);
  });
  window.addEventListener(LINK_EVENT, (e) => {
    const { id, done, total } = (e as CustomEvent<CloudLinkProgress>).detail;
    const known = getCloudLinkProgress();
    if (known?.id === id) setCloudLinkProgress({ ...known, done, total });
  });
}

/** Перечитать состояние движка (после синка, события, своей правки). */
export async function refreshCloud(): Promise<CloudDriveState | undefined> {
  const result = await callParvane('parvaneCloudState').catch(() => undefined) as CloudDriveState | undefined;
  if (!result) return undefined;
  setCloudStatus(result.status);
  if (result.status !== 'needs-linking' && result.status !== 'loading') {
    setCloudData(result);
    setIsCloudLoaded(true);
    fixPlace(result);
  }
  if (result.status === 'needs-linking' && linkingTimer === undefined && typeof window !== 'undefined') {
    // Пока устройство не привязано, стек облака не запускается — опрашиваем до готовности
    linkingTimer = window.setInterval(() => {
      void refreshCloud().then((next) => {
        if (next && next.status !== 'needs-linking' && next.status !== 'loading' && linkingTimer !== undefined) {
          window.clearInterval(linkingTimer);
          linkingTimer = undefined;
        }
      });
    }, LINKING_POLL_MS);
  }
  return result;
}

/** Открытая папка или контейнер исчезли (удалены, доступ отозван) — подняться выше. */
function fixPlace(data: CloudDriveState) {
  const place = getCloudPlace();
  if (place.container && !data.containers.some((c) => c.id === place.container)) {
    // Чужая папка пропала — остаться в «Доступных мне», своя — в корне
    setCloudPlaceSignal(place.view ? { view: place.view } : {});
    return;
  }
  if (!place.folder) return;
  const id = place.container || data.rootId;
  const folder = id ? data.trees[id]?.nodes.find((n) => n.id === place.folder) : undefined;
  if (!folder || folder.trashed) setCloudPlaceSignal({ view: place.view, container: place.container });
}

// `userId` — текущий аккаунт: при его смене в той же вкладке состояние читается заново
export function loadCloud(userId?: string) {
  listen();
  if (loadedUserId !== userId) {
    resetCloud();
    loadedUserId = userId;
  }
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      const result = await refreshCloud();
      if (result && result.status !== 'loading') break;
      await new Promise((resolve) => {
        setTimeout(resolve, LOAD_RETRY_MS);
      });
    }
    void refreshCloudUsage();
    // Непривязанному устройству методы ссылок недоступны — список остаётся незагруженным
    if (getCloudStatus() !== 'needs-linking') void refreshCloudLinks();
  })();
  return loadPromise;
}

function resetCloud() {
  loadPromise = undefined;
  setCloudData(undefined);
  setIsCloudLoaded(false);
  setCloudStatus('loading');
  setCloudPlaceSignal({});
  setCloudTransfers([]);
  setCloudUsage(undefined);
  setCloudLinks(undefined);
  setCloudLinkProgress(undefined);
  uploadSpecs.clear();
  if (linkingTimer !== undefined) {
    window.clearInterval(linkingTimer);
    linkingTimer = undefined;
  }
}

let activeHolders = 0;

/** Экран облака («Файлы» либо «Знания» — заметки лежат в облаке) открыт/закрыт: частый либо редкий опрос сервера.
 * Экранов несколько — опрос частый, пока открыт хотя бы один. */
export function setCloudActive(isActive: boolean) {
  const wasActive = activeHolders > 0;
  activeHolders = Math.max(0, activeHolders + (isActive ? 1 : -1));
  const isNowActive = activeHolders > 0;
  if (wasActive === isNowActive) return;
  void callParvane('parvaneCloudSetActive', { isActive: isNowActive }).catch(() => undefined);
}

export async function refreshCloudUsage() {
  const usage = await callParvane('parvaneCloudUsage').catch(() => undefined) as CloudUsage | undefined;
  if (usage) setCloudUsage(usage);
}

// ── дерево ───────────────────────────────────────────────────────────────────

/** Контейнер текущего места: совместная папка либо личный диск. */
export function getActiveContainerId(place = getCloudPlace(), data = getCloudData()) {
  return place.container || data?.rootId;
}

export function getContainer(id?: string, data = getCloudData()): CloudContainerInfo | undefined {
  return id ? data?.containers.find((c) => c.id === id) : undefined;
}

/**
 * Подпись человека в облаке: ник для своего сервера, полный адрес для чужого — иначе `alice@чужой.сервер`
 * выглядит как свой контакт `alice` (федерация, spec 028). Свой сервер — по владельцу личного диска.
 */
export function peerLabel(address: string, data = getCloudData()) {
  const [nick, domain] = address.split('@');
  const selfDomain = data?.containers.find((c) => c.kind === 'root')?.owner.split('@')[1];
  if (!domain || !selfDomain || domain.toLowerCase() === selfDomain.toLowerCase()) return nick;
  return address;
}

export function getNodes(id?: string, data = getCloudData()): CloudNode[] {
  return (id && data?.trees[id]?.nodes) || [];
}

/** Может ли пользователь менять содержимое контейнера (диск, свой либо как редактор). */
export function canEditContainer(id?: string, data = getCloudData()) {
  if (!id) return true;
  const role = getContainer(id, data)?.role;
  return role === 'owner' || role === 'editor';
}

async function applyOps(container: string | undefined, ops: unknown[]) {
  if (!ops.length) return true;
  const result = await callParvane('parvaneCloudApply', { container: container || ROOT, ops })
    .catch(() => undefined) as CloudResult | undefined;
  if (!result?.ok) {
    showCloudNotice(result?.error || 'rejected');
    return false;
  }
  await refreshCloud();
  return true;
}

function newNodeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createCloudFolder(name: string) {
  const place = getCloudPlace();
  const container = getActiveContainerId(place);
  const taken = namesIn(getNodes(container), place.folder);
  return applyOps(container, [{
    op: 'create', id: newNodeId(), kind: 'folder', parent: place.folder, name: freeName(taken, name),
  }]);
}

export function renameCloudNode(container: string, node: CloudNode, name: string) {
  if (name === node.name) return Promise.resolve(true);
  const taken = namesIn(getNodes(container), node.parent || undefined, node.id);
  return applyOps(container, [{
    op: 'move', id: node.id, parent: node.parent || undefined, name: freeName(taken, name),
  }]);
}

/** Переместить узлы в папку того же контейнера (`target` не задан — корень). */
export function moveCloudNodes(container: string, nodes: CloudNode[], target?: string) {
  const taken = new Set(namesIn(getNodes(container), target));
  const ops = nodes.filter((n) => (n.parent || undefined) !== target).map((n) => {
    const name = freeName(taken, n.name);
    taken.add(name);
    return {
      op: 'move', id: n.id, parent: target, name,
    };
  });
  return applyOps(container, ops);
}

function addMoveTransfer(container: string, nodes: CloudNode[]) {
  const id = `move-${Date.now()}-${++transferSeq}`;
  const all = getNodes(container);
  const name = nodes.length > 1 ? `${nodes[0].name} +${nodes.length - 1}` : nodes[0].name;
  setCloudTransfers([...getCloudTransfers(), {
    id, kind: 'move', name, done: 0, total: nodes.reduce((sum, n) => sum + sizeOf(all, n.id), 0), state: 'active',
  }]);
  return id;
}

/** Переместить узлы в папку другого контейнера: личный диск ↔ совместная папка. */
export async function moveCloudNodesAcross(from: string, nodes: CloudNode[], to: string, target?: string) {
  if (!nodes.length) return;
  const taken = new Set(namesIn(getNodes(to), target));
  const items = nodes.map((n) => {
    const name = freeName(taken, n.name);
    taken.add(name);
    return { id: n.id, name };
  });
  await callParvane('parvaneCloudMove', {
    from, items, to, parent: target, transferId: addMoveTransfer(from, nodes),
  }).catch(() => undefined);
  await refreshCloud();
  void refreshCloudUsage();
}

/** Сделать папку личного диска совместной; возвращает id новой совместной папки. */
export async function shareCloudFolder(container: string, node: CloudNode) {
  const result = await callParvane('parvaneCloudShareFolder', {
    container, node: node.id, transferId: addMoveTransfer(container, [node]),
  }).catch(() => undefined) as CloudResult<{ container: string }> | undefined;
  await refreshCloud();
  void refreshCloudUsage();
  return result?.ok ? result.container : undefined;
}

/** Сделать свою совместную папку обычной папкой личного диска. */
export async function unshareCloudFolder(container: string, fallbackName: string) {
  const data = getCloudData();
  const name = freeName(namesIn(getNodes(data?.rootId, data)), getContainer(container, data)?.name || fallbackName);
  const nodes = getNodes(container, data);
  const id = `move-${Date.now()}-${++transferSeq}`;
  setCloudTransfers([...getCloudTransfers(), {
    id, kind: 'move', name, done: 0, total: usageOf(nodes).total - usageOf(nodes).trash, state: 'active',
  }]);
  const result = await callParvane('parvaneCloudUnshareFolder', { container, name, transferId: id })
    .catch(() => undefined) as CloudResult | undefined;
  await refreshCloud();
  void refreshCloudUsage();
  return Boolean(result?.ok);
}

export function trashCloudNodes(container: string, nodes: CloudNode[]) {
  const at = Date.now();
  return applyOps(container, nodes.map((n) => ({
    op: 'trash', id: n.id, trashed: true, at,
  })));
}

/** Вернуть из корзины: в прежнюю папку, а если её уже нет — в корень; занятое имя — с номером. */
export function restoreCloudNodes(container: string, nodes: CloudNode[]) {
  const all = getNodes(container);
  const ops: unknown[] = [];
  const takenByParent = new Map<string, Set<string>>();
  nodes.forEach((n) => {
    const parentNode = n.parent ? all.find((p) => p.id === n.parent) : undefined;
    const parent = parentNode && !parentNode.trashed ? parentNode.id : undefined;
    const key = parent || '';
    const taken = takenByParent.get(key) || new Set(namesIn(all, parent));
    takenByParent.set(key, taken);
    const name = freeName(taken, n.name);
    taken.add(name);
    if (name !== n.name || parent !== (n.parent || undefined)) {
      ops.push({
        op: 'move', id: n.id, parent, name,
      });
    }
    ops.push({
      op: 'trash', id: n.id, trashed: false, at: 0,
    });
  });
  return applyOps(container, ops);
}

/** Удалить окончательно: узлы и всё вложенное; место освободится после сборки блобов. */
export async function purgeCloudNodes(container: string, nodes: CloudNode[]) {
  const at = Date.now();
  const isDone = await applyOps(container, nodes.map((n) => ({ op: 'purge', id: n.id, at })));
  if (isDone) {
    await callParvane('parvaneCloudSync').catch(() => undefined);
    void refreshCloudUsage();
  }
  return isDone;
}

/** Корзины всех контейнеров, где пользователь вправе восстанавливать и стирать. */
export function getTrash(data = getCloudData()): { container: string; node: CloudNode }[] {
  if (!data) return [];
  return data.containers
    .filter((c) => c.kind !== 'invite' && (c.role === 'owner' || c.role === 'editor'))
    .flatMap((c) => trashOf(getNodes(c.id, data)).map((node) => ({ container: c.id, node })));
}

export async function emptyCloudTrash() {
  const byContainer = new Map<string, CloudNode[]>();
  getTrash().forEach(({ container, node }) => {
    byContainer.set(container, [...(byContainer.get(container) || []), node]);
  });
  for (const [container, nodes] of byContainer) await purgeCloudNodes(container, nodes);
}

// ── совместные папки ─────────────────────────────────────────────────────────

async function callShared(method: string, args: Record<string, unknown>) {
  const result = await callParvane(method, args).catch(() => undefined) as CloudResult | undefined;
  if (!result?.ok) showCloudNotice(result?.error || 'rejected');
  await refreshCloud();
  return Boolean(result?.ok);
}

/** Ответить на приглашение в чужую папку; принятая сразу открывается. */
export async function answerCloudInvite(container: string, isAccepted: boolean) {
  const isDone = await callShared('parvaneCloudAnswerInvite', { container, isAccepted });
  if (isDone && isAccepted && getContainer(container)) setCloudPlaceSignal({ view: 'shared', container });
  return isDone;
}

/** Покинуть чужую совместную папку. */
export function leaveCloudFolder(container: string) {
  return callShared('parvaneCloudLeave', { container });
}

// ── загрузка и скачивание ────────────────────────────────────────────────────

function applyTransferEvent(event: CloudTransferEvent) {
  const list = getCloudTransfers();
  const known = list.find((t) => t.id === event.id);
  if (!known) return;
  const next = { ...known, ...event };
  setCloudTransfers(list.map((t) => (t.id === event.id ? next : t)));
  if (event.state === 'done' || event.state === 'canceled') {
    if (event.kind === 'upload') uploadSpecs.delete(event.id);
    setTimeout(() => dismissCloudTransfer(event.id), event.state === 'done' ? DONE_HIDE_MS : 0);
  }
}

function dismissCloudTransfer(id: string) {
  setCloudTransfers(getCloudTransfers().filter((t) => t.id !== id));
  uploadSpecs.delete(id);
}

async function runUpload(id: string): Promise<boolean> {
  const spec = uploadSpecs.get(id);
  if (!spec) return false;
  const result = await callParvane('parvaneCloudUpload', {
    uploadId: id,
    container: spec.container,
    parent: spec.parent,
    name: spec.name,
    file: spec.file,
    mime: spec.file.type,
    mtime: spec.file.lastModified,
  }).catch(() => undefined) as CloudResult | undefined;
  if (result?.ok) {
    await refreshCloud();
    void refreshCloudUsage();
  }
  return Boolean(result?.ok);
}

/** Загрузить файлы в текущую папку: каждый — своей строкой хода; имена не затирают соседей. */
export function uploadCloudFiles(files: File[]) {
  const place = getCloudPlace();
  void uploadCloudFilesTo(getActiveContainerId(place) || ROOT, place.folder, files);
}

/** Загрузить файлы в папку `parent` контейнера (вставка в заметку): итог — имена в облаке по порядку файлов;
 * не загрузившийся — `undefined` на его месте. Ход виден в панели переводов, как у обычной загрузки. */
export async function uploadCloudFilesTo(
  container: string, parent: string | undefined, files: File[],
): Promise<(string | undefined)[]> {
  const taken = new Set(namesIn(getNodes(container === ROOT ? undefined : container), parent));
  getCloudTransfers().forEach((t) => {
    const spec = uploadSpecs.get(t.id);
    if (spec && spec.container === container && spec.parent === parent) taken.add(spec.name);
  });
  const added: CloudTransfer[] = [];
  files.forEach((file) => {
    const id = `up-${Date.now()}-${++transferSeq}`;
    const name = freeName(taken, normalizeName(file.name || 'file'));
    taken.add(name);
    uploadSpecs.set(id, {
      container, parent, name, file,
    });
    added.push({
      id, kind: 'upload', name, done: 0, total: file.size, state: 'active',
    });
  });
  setCloudTransfers([...getCloudTransfers(), ...added]);
  // По очереди: параллельные большие файлы делили бы одно окно запросов
  const names: (string | undefined)[] = [];
  for (const t of added) {
    names.push(await runUpload(t.id) ? t.name : undefined);
  }
  return names;
}

export function retryCloudUpload(id: string) {
  setCloudTransfers(getCloudTransfers().map((t) => (t.id === id ? { ...t, state: 'active', error: undefined } : t)));
  void runUpload(id);
}

export function cancelCloudTransfer(transfer: CloudTransfer) {
  if (transfer.state !== 'active') {
    dismissCloudTransfer(transfer.id);
    void callParvane('parvaneCloudCancelUpload', { uploadId: transfer.id }).catch(() => undefined);
    return;
  }
  const method = transfer.kind === 'upload' ? 'parvaneCloudCancelUpload'
    : transfer.kind === 'move' ? 'parvaneCloudCancelMove' : 'parvaneCloudCancelDownload';
  const args = transfer.kind === 'upload' ? { uploadId: transfer.id } : { transferId: transfer.id };
  void callParvane(method, args).catch(() => undefined);
}

type SavePicker = (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;

/** Скачать файл на устройство: большой — потоком в выбранный файл, иначе через память. */
export async function downloadCloudNode(container: string, node: CloudNode, maxMemoryBytes: number) {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  let handle: FileSystemFileHandle | undefined;
  if (picker && node.size > STREAM_DOWNLOAD_BYTES) {
    try {
      handle = await picker({ suggestedName: node.name });
    } catch {
      // Пользователь закрыл окно выбора файла
      return;
    }
  }
  if (!handle && node.size > maxMemoryBytes) {
    showCloudNotice('too-large');
    return;
  }
  const id = `down-${Date.now()}-${++transferSeq}`;
  setCloudTransfers([...getCloudTransfers(), {
    id, kind: 'download', name: node.name, done: 0, total: node.size, state: 'active',
  }]);
  const result = await callParvane('parvaneCloudDownload', {
    container, node: node.id, handle, transferId: id,
  }).catch(() => undefined) as CloudResult<{ blob?: Blob; name: string }> | undefined;
  if (!result?.ok || !result.blob) return;
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── ссылки для людей без аккаунта (spec 022) ─────────────────────────────────

/** Чья ссылка создаётся: узел контейнера либо совместная папка целиком (`node` не задан). */
export type CloudLinkSource = { container: string; node?: string; name: string };

/** Последняя готовая ссылка на узел (источник — в записи владельца). */
export function linkOfSource(links: CloudLinkInfo[] | undefined, source: { container: string; node?: string }) {
  return (links || []).find((l) => (
    l.state !== 'preparing' && l.source?.container === source.container && l.source.node === (source.node || '')
  ));
}

export async function refreshCloudLinks() {
  const result = await callParvane('parvaneCloudLinks').catch(() => undefined) as
    CloudResult<{ links: CloudLinkInfo[] }> | undefined;
  if (result?.ok) setCloudLinks(result.links);
  return result?.ok ? result.links : undefined;
}

/** Создать ссылку; ход подготовки — `getCloudLinkProgress`. Одновременно готовится одна ссылка. */
export async function createCloudLink(source: CloudLinkSource, ttlDays: number) {
  if (getCloudLinkProgress()) return undefined;
  const id = `link-${Date.now()}-${++transferSeq}`;
  setCloudLinkProgress({
    id, done: 0, total: 0, container: source.container, node: source.node || '',
  });
  try {
    const result = await callParvane('parvaneCloudLinkCreate', {
      container: source.container, node: source.node, name: source.name, ttlDays, transferId: id,
    }).catch(() => undefined) as CloudResult<{ link: CloudLinkInfo }> | undefined;
    if (!result?.ok) {
      // Отмена самим пользователем — не ошибка
      if (!canceledLinks.delete(id)) showCloudNotice(result?.error || 'rejected');
      return undefined;
    }
    setCloudLinks([result.link, ...(getCloudLinks() || []).filter((l) => l.id !== result.link.id)]);
    return result.link;
  } finally {
    setCloudLinkProgress(undefined);
    void refreshCloudLinks();
    void refreshCloudUsage();
  }
}

export function cancelCloudLinkCreate() {
  const progress = getCloudLinkProgress();
  if (!progress) return;
  canceledLinks.add(progress.id);
  void callParvane('parvaneCloudLinkCancel', { transferId: progress.id }).catch(() => undefined);
}

export async function revokeCloudLink(linkId: string) {
  const result = await callParvane('parvaneCloudLinkRevoke', { linkId }).catch(() => undefined) as
    CloudResult | undefined;
  if (!result?.ok) showCloudNotice(result?.error || 'rejected');
  else setCloudLinks((getCloudLinks() || []).filter((l) => l.id !== linkId));
  void refreshCloudLinks();
  void refreshCloudUsage();
  return Boolean(result?.ok);
}

export async function extendCloudLink(linkId: string, ttlDays: number) {
  const result = await callParvane('parvaneCloudLinkExtend', { linkId, ttlDays }).catch(() => undefined) as
    CloudResult<{ expiresAt: number }> | undefined;
  if (!result?.ok) showCloudNotice(result?.error || 'rejected');
  await refreshCloudLinks();
  return Boolean(result?.ok);
}
