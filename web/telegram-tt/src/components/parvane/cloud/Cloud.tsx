import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { GlobalState } from '../../../global/types';
import type { CloudMovePlace } from './CloudDialogs';
import type { CloudItemAction } from './CloudItem';
import type { CloudLinkTarget } from './CloudLinkDialog';
import type { CloudMenuAction, CloudMenuAnchor } from './CloudMenu';
import type { CloudNode, CloudSortKey } from './cloudModel';
import type { CloudNavCounts, CloudNavPlace } from './CloudNav';
import type { CloudPlace, CloudVirtualFolder } from './cloudStore';

import { IS_TOUCH_ENV, MAX_BUFFER_SIZE } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import {
  consumeModuleAddRequest, getIsParvaneScreenShown, getModuleAddRequest, getParvaneSection,
  setParvaneSection,
} from '../../../util/parvaneSection';
import { formatFileSize } from '../../../util/textFormat';
import { dropPlaceTitle } from './cloudDrop';
import {
  childrenOf, fileTypeLabel, folderStats, listedNodes, pathOf, searchNodes, sortNodes, trashDaysLeft, usageOf,
} from './cloudModel';
import {
  canEditContainer, copyCloudNode, createCloudFolder, downloadCloudNode, emptyCloudTrash, getActiveContainerId,
  getCloudData,
  getCloudLinks, getCloudNotice, getCloudPlace, getCloudPrefs, getCloudStatus, getCloudUsage, getContainer,
  getHasCloudTransfers, getIsCloudLoaded, getNodes, getTrash, hideCloudNotice, leaveCloudFolder, linkOfSource,
  loadCloud, moveCloudNodes, moveCloudNodesAcross, peerLabel, purgeCloudNodes, refreshCloud, refreshCloudLinks,
  renameCloudNode, restoreCloudNodes, retryCloud,
  revokeDeadCloudLinks, setCloudActive, setCloudPlace, setCloudPrefs,
  shareCloudFolder, trashCloudNodes, uploadCloudFiles,
} from './cloudStore';
import useCloudDrag from './useCloudDrag';
import useCloudOffline from './useCloudOffline';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';
import useWindowSize from '../../../hooks/window/useWindowSize';

import ConfirmDialog from '../../ui/ConfirmDialog';
import PvEmpty from '../notes/PvEmpty';
import PvHeaderSearch from '../notes/PvHeaderSearch';
import PvIcon from '../notes/PvIcon';
import PvOfflineBar from '../notes/PvOfflineBar';
import PvSkeleton from '../notes/PvSkeleton';
import SectionHistoryBack from '../SectionHistoryBack';
import CloudDetail from './CloudDetail';
import { CloudFolderDialog, CloudNameDialog } from './CloudDialogs';
import CloudDropZone from './CloudDropZone';
import CloudItem from './CloudItem';
import CloudLinkDialog from './CloudLinkDialog';
import CloudMenu from './CloudMenu';
import CloudNav from './CloudNav';
import CloudNoteDialog from './CloudNoteDialog';
import CloudPreview from './CloudPreview';
import { CloudContainerRow, CloudInviteCard, CloudLinkRow } from './CloudRows';
import CloudSendDialog from './CloudSendDialog';
import CloudShareDialog from './CloudShareDialog';
import CloudTransfers, { CLOUD_ERROR_KEYS } from './CloudTransfers';
import CloudUsage, { getIsCloudAlmostFull } from './CloudUsage';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';
import dragStyles from './CloudDrag.module.scss';

type OwnProps = {
  isMobile?: boolean;
};

type Entry = { container: string; node: CloudNode };
// Чьё меню «⋯» открыто: файла либо папки дерева или строки совместной папки
type MenuTarget = ({ type: 'node'; entry: Entry } | { type: 'container'; id: string })
  & { anchor?: CloudMenuAnchor };
type ContainerAction = 'open' | 'access' | 'leave';
type Dialog =
  | { type: 'newFolder' }
  | { type: 'newShared' }
  | { type: 'rename'; entry: Entry }
  | { type: 'move'; container: string; nodes: CloudNode[] }
  | { type: 'purge'; entries: Entry[] }
  | { type: 'emptyTrash' }
  | { type: 'share'; container: string }
  | { type: 'shareFolder'; entry: Entry }
  | { type: 'leave'; container: string }
  | { type: 'link'; target: CloudLinkTarget }
  | { type: 'send'; entries: Entry[] }
  | { type: 'note'; entry: Entry };

const SORT_KEYS: CloudSortKey[] = ['name', 'date', 'size'];
// Просмотр держит файл в памяти: на телефоне предел ниже
const PREVIEW_MAX_BYTES_DESKTOP = 256 * 1024 * 1024;
const PREVIEW_MAX_BYTES_MOBILE = 64 * 1024 * 1024;
// Как в стилях: уже — раскладка телефона
const NARROW_WIDTH = 760;
// Поиск по всем папкам применяется с задержкой после ввода, а не на каждую букву
const SEARCH_DEBOUNCE_MS = 150;
const NO_CHILDREN = { count: 0, size: 0 };
// Папка хранилища заметок в корне личного диска (названия — как в `notes/notesStore.ts`)
const VAULT_NAMES = ['Знания', 'Knowledge'];
const SORT_SHORT_KEYS = {
  name: 'ParvaneCloudName', date: 'ParvaneCloudModified', size: 'ParvaneCloudSize',
} as const;
const SORT_TITLE_KEYS = {
  name: 'ParvaneCloudSortName', date: 'ParvaneCloudSortDate', size: 'ParvaneCloudSortSize',
} as const;
// Пустое место (доска `PhStates`: заголовок и что здесь бывает): подсказка под заголовком
const EMPTY_HINT_KEYS = {
  ParvaneCloudEmpty: 'ParvaneCloudEmptyHint',
  ParvaneCloudEmptyFolder: 'ParvaneCloudEmptyHint',
  ParvaneCloudEmptyTrash: 'ParvaneCloudEmptyTrashHint',
  ParvaneCloudEmptyShared: 'ParvaneCloudEmptySharedHint',
  ParvaneCloudEmptyOwned: 'ParvaneCloudEmptyOwnedHint',
  ParvaneCloudLinksEmpty: 'ParvaneCloudLinksEmptyHint',
} as const;
const VIEW_KEYS = {
  owned: 'ParvaneCloudTabOwned',
  shared: 'ParvaneCloudTabShared',
  links: 'ParvaneCloudLinks',
  trash: 'ParvaneCloudTabTrash',
} as const;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

function keyOf(entry: Entry) {
  return `${entry.container}/${entry.node.id}`;
}

// Parvane (spec 016, вид — spec 041 E2): «Файлы» по макету. Места — «Мой диск», «Общие папки», «Доступные мне»,
// «Мои ссылки», «Корзина»: колонка слева на компьютере, чипы под шапкой на телефоне. Список — таблица
// «Имя / Доступ / Изменён / Размер» (телефон: строки со второй строкой сведений); выбранный файл на компьютере
// показан в панели справа. Действия, перенос, доступ, ссылка — окна; просмотр — тёмный, на весь экран.
// Дерево — контейнеры домена `cloud.v1` (cloudStore), содержимое файлов сервер не видит.
const Cloud = ({ isMobile }: OwnProps) => {
  const lang = useLang();

  const data = useDerivedState(getCloudData);
  const isLoaded = useDerivedState(getIsCloudLoaded);
  const isOffline = useCloudOffline();
  const status = useDerivedState(getCloudStatus);
  const place = useDerivedState(getCloudPlace);
  const prefs = useDerivedState(getCloudPrefs);
  // Сам ход переносов показывает `CloudTransfers`; здесь нужно лишь знать, есть ли они
  const hasTransfers = useDerivedState(getHasCloudTransfers);
  const usage = useDerivedState(getCloudUsage);
  const notice = useDerivedState(getCloudNotice);
  const links = useDerivedState(getCloudLinks);

  const [query, setQuery] = useState('');
  const [isSearchOpen, openSearch, closeSearch] = useFlag();
  // Запрос, по которому строится список: с задержкой после ввода, очистка — сразу
  const [appliedQuery, setAppliedQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  // Компьютер: файл, чьи сведения показаны в панели справа
  const [currentKey, setCurrentKey] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [preview, setPreview] = useState<Entry>();
  const [menu, setMenu] = useState<MenuTarget>();
  const fileInputRef = useRef<HTMLInputElement>();
  // «Вложить в заметку» нет, если «Заметки» выключены сервером (MODULES-1)
  const notesModule = useParvaneModules().states.find((m) => m.id === 'notes');
  const canAttachToNote = Boolean(notesModule && !notesModule.isServerOff && !notesModule.isUnavailable);

  const currentUserId = useSelector(selectCurrentUserId);
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;

  useEffect(() => {
    void loadCloud(currentUserId);
  }, [currentUserId]);

  // Пока раздел на экране, сервер опрашивается часто; скрыт (раздел остаётся смонтированным) — редко
  // Зависимости — сигналы раздела: по ним значение пересчитывается
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  const isShown = useDerivedState(() => getIsParvaneScreenShown('files'), [getParvaneSection]);
  useEffect(() => {
    if (!isShown) return undefined;
    setCloudActive(true);
    return () => setCloudActive(false);
  }, [isShown]);

  // Счётчик «Моих ссылок» виден сразу, как диск готов; список перечитывается и при каждом открытии места (срок
  // мог истечь). Пока диска нет (устройство не привязано, ключ не пришёл), ссылки не запрашиваются
  const isLinksPlace = place.view === 'links';
  const isReady = status === 'ready';
  useEffect(() => {
    if (isShown && isReady) void refreshCloudLinks();
  }, [isShown, isReady, isLinksPlace]);

  useEffect(() => {
    if (!query.trim()) {
      setAppliedQuery('');
      return undefined;
    }
    const timer = setTimeout(() => setAppliedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmedQuery = appliedQuery.trim();
  const isSearch = Boolean(trimmedQuery);
  const isVirtual = place.view !== undefined && !place.container;
  const isTrash = !isSearch && isVirtual && place.view === 'trash';
  const isSharedList = !isSearch && isVirtual && place.view === 'shared';
  const isOwnedList = !isSearch && isVirtual && place.view === 'owned';
  const isLinksList = !isSearch && isVirtual && place.view === 'links';
  const isRoot = !isSearch && !place.view && !place.container && !place.folder;
  const containerId = isVirtual ? undefined : getActiveContainerId(place, data);
  const container = getContainer(place.container, data);
  const nodes = getNodes(containerId, data);
  // Загружать и создавать можно в открытой папке; списки мест только показывают
  const canEdit = !isVirtual && canEditContainer(place.container, data);

  // Выделение и выбранный файл сбрасываются при смене места и запроса
  useEffect(() => {
    setSelected([]);
    setCurrentKey(undefined);
  }, [place, trimmedQuery]);

  const allContainers = data?.containers;
  const ownedFolders = useMemo(() => (allContainers || []).filter((c) => c.kind === 'owned'), [allContainers]);
  const sharedFolders = useMemo(() => (allContainers || []).filter((c) => c.kind === 'shared'), [allContainers]);
  const invites = useMemo(() => (allContainers || []).filter((c) => c.kind === 'invite'), [allContainers]);
  const trash = useMemo(() => getTrash(data), [data]);
  // Счётчики папок (число детей, размер поддерева) — одним проходом по каждому контейнеру
  const statsByContainer = useMemo(() => new Map(
    (allContainers || []).map((c) => [c.id, folderStats(getNodes(c.id, data))]),
  ), [allContainers, data]);

  const entries: Entry[] = useMemo(() => {
    if (trimmedQuery) {
      // Поиск — по всем папкам: личный диск, свои и принятые совместные; корзина не в счёт
      const owners = new Map<CloudNode, string>();
      (allContainers || []).filter((c) => c.kind !== 'invite').forEach((c) => {
        searchNodes(listedNodes(getNodes(c.id, data)), trimmedQuery).forEach((node) => owners.set(node, c.id));
      });
      return sortNodes(Array.from(owners.keys()), prefs.sort).map((node) => ({ container: owners.get(node)!, node }));
    }
    if (isTrash) return trash;
    if (!containerId) return [];
    // Служебные файлы Parvane (отметка справки в хранилище заметок) в списке не показываются
    return sortNodes(childrenOf(listedNodes(nodes), place.folder), prefs.sort)
      .map((node) => ({ container: containerId, node }));
  }, [trimmedQuery, allContainers, data, prefs.sort, isTrash, trash, containerId, nodes, place.folder]);

  // Куда можно переносить: личный диск и совместные папки с правом записи
  const movePlaces: CloudMovePlace[] = useMemo(() => (
    (allContainers || [])
      .filter((c) => c.kind !== 'invite' && (c.role === 'owner' || c.role === 'editor'))
      .map((c) => ({
        id: c.id,
        name: c.kind === 'root' ? lang('ParvaneCloudTabDrive') : c.name || lang('ParvaneCloudSharedFolder'),
        isShared: c.kind !== 'root',
        nodes: getNodes(c.id, data),
      }))
  ), [allContainers, data, lang]);

  const navCounts: CloudNavCounts = useMemo(() => ({
    owned: ownedFolders.length,
    shared: sharedFolders.length + invites.length,
    links: links?.length || 0,
    trash: trash.length,
  }), [ownedFolders, sharedFolders, invites, links, trash]);

  const selectedEntries = entries.filter((e) => selected.includes(keyOf(e)));
  const current = !isNarrow && !isTrash && !selectedEntries.length
    ? entries.find((e) => keyOf(e) === currentKey && e.node.kind === 'file') : undefined;
  const path = useMemo(() => pathOf(nodes, place.folder), [nodes, place.folder]);
  const sizes = useMemo(() => usageOf(getNodes(data?.rootId, data)), [data]);
  // Сроки корзины считаются от момента, когда список в последний раз менялся
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [data, place]);

  const canEditEntry = (entry: Entry) => canEditContainer(entry.container, data);
  const editableSelection = selectedEntries.filter(canEditEntry);
  // Переносить разом можно только лежащее в одном контейнере
  const selectionContainer = editableSelection.length === selectedEntries.length
    && selectedEntries.every((e) => e.container === selectedEntries[0].container)
    ? selectedEntries[0]?.container : undefined;

  const containerName = (c?: CloudContainerInfo) => c?.name || lang('ParvaneCloudSharedFolder');
  const virtualName = (view: CloudVirtualFolder) => lang(VIEW_KEYS[view]);

  /** Место узла: чужая папка лежит под «Доступными мне», своя общая — под диском либо «Общими папками». */
  const placeOf = (id: string, folder?: string): CloudPlace => {
    if (id === data?.rootId) return { folder };
    const isShared = getContainer(id, data)?.kind === 'shared';
    return { view: isShared ? 'shared' : place.view === 'owned' ? 'owned' : undefined, container: id, folder };
  };

  /** Путь до папки узла словами — подпись найденного. */
  const pathText = (entry: Entry) => {
    const entryPlace = placeOf(entry.container);
    return [
      entryPlace.view ? virtualName(entryPlace.view) : lang('ParvaneCloudTabDrive'),
      ...(entryPlace.container ? [containerName(getContainer(entryPlace.container, data))] : []),
      ...pathOf(getNodes(entry.container, data), entry.node.parent || undefined).map((n) => n.name),
    ].join(' / ');
  };

  const goTo = (next: CloudPlace) => {
    setQuery('');
    setCloudPlace(next);
  };

  // Телефон: поле поиска раскрыто лупой в шапке либо в нём осталась строка
  const isSearchShown = isSearchOpen || Boolean(query);

  const handleSearchClose = useLastCallback(() => {
    setQuery('');
    closeSearch();
  });

  const handleNav = useLastCallback((next: CloudNavPlace) => goTo(next === 'drive' ? {} : { view: next }));
  const handleOpenView = useLastCallback(() => goTo(place.view ? { view: place.view } : {}));
  const handleOpenTrash = useLastCallback(() => goTo({ view: 'trash' }));

  const handleOpenFolder = useLastCallback((folder?: string) => {
    goTo({ view: place.view, container: place.container, folder });
  });

  const handleOpenContainer = useLastCallback((id: string) => goTo(placeOf(id)));

  // Системное «назад»: из папки — в родительскую, из корня — к чатам
  const handleHistoryBack = useLastCallback(() => {
    if (isSearchShown) {
      handleSearchClose();
    } else if (path.length) {
      handleOpenFolder(path[path.length - 2]?.id);
    } else if (place.container) {
      goTo(place.view ? { view: place.view } : {});
    } else if (place.view) {
      goTo({});
    } else {
      setParvaneSection('messenger');
      return false;
    }
    return true;
  });

  // Папка открывается сразу; файл на компьютере сперва выбирается, просмотр — двойным нажатием либо Enter
  const handleOpen = useLastCallback((entryContainer: string, node: CloudNode, isForced?: boolean) => {
    if (node.kind === 'folder') {
      goTo(placeOf(entryContainer, node.id));
      return;
    }
    const entry = { container: entryContainer, node };
    if (isNarrow || isForced) setPreview(entry);
    else setCurrentKey(keyOf(entry));
  });

  const handlePreviewNavigate = useLastCallback((entryContainer: string, node: CloudNode) => {
    setPreview({ container: entryContainer, node });
  });

  const handleToggle = useLastCallback((node: CloudNode) => {
    const entry = entries.find((e) => e.node.id === node.id);
    if (!entry) return;
    const key = keyOf(entry);
    setSelected(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  });

  const handleDownload = useLastCallback((entryContainer: string, node: CloudNode) => {
    void downloadCloudNode(entryContainer, node, MAX_BUFFER_SIZE);
  });

  const handleAction = useLastCallback((action: CloudItemAction, entryContainer: string, node: CloudNode) => {
    const entry = { container: entryContainer, node };
    if (action === 'select') {
      const key = keyOf(entry);
      if (!selected.includes(key)) setSelected([...selected, key]);
    }
    if (action === 'open') handleOpen(entryContainer, node, true);
    if (action === 'download') handleDownload(entryContainer, node);
    if (action === 'rename') setDialog({ type: 'rename', entry });
    if (action === 'move') setDialog({ type: 'move', container: entryContainer, nodes: [node] });
    if (action === 'delete') void trashCloudNodes(entryContainer, [node]);
    if (action === 'restore') void restoreCloudNodes(entryContainer, [node]);
    if (action === 'purge') setDialog({ type: 'purge', entries: [entry] });
    if (action === 'send') setDialog({ type: 'send', entries: [entry] });
    if (action === 'share') setDialog({ type: 'shareFolder', entry });
    if (action === 'copy') void copyCloudNode(entryContainer, node);
    if (action === 'note') setDialog({ type: 'note', entry });
    if (action === 'link') {
      setDialog({ type: 'link', target: { source: { container: entryContainer, node: node.id, name: node.name } } });
    }
  });

  // Действие из просмотра: окно действия открывается вместо него
  const handlePreviewAction = useLastCallback((action: CloudItemAction, entryContainer: string, node: CloudNode) => {
    if (action !== 'download') setPreview(undefined);
    handleAction(action, entryContainer, node);
  });

  // Меню у курсора — только на компьютере; на телефоне — шторка
  const handleMenu = useLastCallback((entryContainer: string, node: CloudNode, anchor?: CloudMenuAnchor) => {
    setMenu({ type: 'node', entry: { container: entryContainer, node }, anchor: isNarrow ? undefined : anchor });
  });

  const handleContainerMenu = useLastCallback((id: string, anchor?: CloudMenuAnchor) => {
    setMenu({ type: 'container', id, anchor: isNarrow ? undefined : anchor });
  });

  const handleContainerAccess = useLastCallback((id: string) => setDialog({ type: 'share', container: id }));
  const handleOpenLink = useLastCallback((linkId: string) => setDialog({ type: 'link', target: { linkId } }));

  const handleCloseMenu = useLastCallback(() => setMenu(undefined));

  const handleMenuPick = useLastCallback((key: string) => {
    const target = menu;
    setMenu(undefined);
    if (!target) return;
    if (target.type === 'node') {
      handleAction(key as CloudItemAction, target.entry.container, target.entry.node);
      return;
    }
    const action = key as ContainerAction;
    if (action === 'open') handleOpenContainer(target.id);
    if (action === 'access') setDialog({ type: 'share', container: target.id });
    if (action === 'leave') setDialog({ type: 'leave', container: target.id });
  });

  const handlePreviewMore = useLastCallback((entryContainer: string, node: CloudNode) => {
    setPreview(undefined);
    setMenu({ type: 'node', entry: { container: entryContainer, node } });
  });

  const handleClearSelection = useLastCallback(() => setSelected([]));
  const handleCloseDialog = useLastCallback(() => setDialog(undefined));
  const handleClosePreview = useLastCallback(() => setPreview(undefined));

  const runByContainer = (list: Entry[], run: (id: string, nodes: CloudNode[]) => Promise<unknown>) => {
    const grouped = new Map<string, CloudNode[]>();
    list.forEach((e) => grouped.set(e.container, [...(grouped.get(e.container) || []), e.node]));
    grouped.forEach((groupNodes, id) => {
      void run(id, groupNodes);
    });
  };

  const handleBulkMove = useLastCallback(() => {
    if (!selectionContainer) return;
    setDialog({ type: 'move', container: selectionContainer, nodes: selectedEntries.map((e) => e.node) });
  });

  const handleBulkDelete = useLastCallback(() => {
    runByContainer(editableSelection, trashCloudNodes);
    setSelected([]);
  });

  const handleBulkDownload = useLastCallback(() => {
    selectedEntries.filter((e) => e.node.kind === 'file').forEach((e) => handleDownload(e.container, e.node));
  });

  const handleBulkSend = useLastCallback(() => {
    const files = selectedEntries.filter((e) => e.node.kind === 'file');
    if (files.length) setDialog({ type: 'send', entries: files });
  });

  const handleBulkRestore = useLastCallback(() => {
    runByContainer(selectedEntries, restoreCloudNodes);
    setSelected([]);
  });

  const handleBulkPurge = useLastCallback(() => {
    setDialog({ type: 'purge', entries: selectedEntries });
  });

  const handleConfirmPurge = useLastCallback(() => {
    if (dialog?.type === 'purge') runByContainer(dialog.entries, purgeCloudNodes);
    if (dialog?.type === 'emptyTrash') void emptyCloudTrash();
    setSelected([]);
    setDialog(undefined);
  });

  const handleConfirmLeave = useLastCallback(() => {
    if (dialog?.type === 'leave') void leaveCloudFolder(dialog.container);
    setDialog(undefined);
  });

  // Новая папка с «сразу открыть доступ» — общая папка: создаётся в диске и переводится в общие
  const handleSubmitName = useLastCallback((name: string, isShared?: boolean) => {
    if (dialog?.type === 'rename') void renameCloudNode(dialog.entry.container, dialog.entry.node, name);
    if (dialog?.type === 'newFolder') {
      const before = new Set(getNodes(getCloudData()?.rootId).map((n) => n.id));
      void createCloudFolder(name).then(async (isDone) => {
        const rootId = getCloudData()?.rootId;
        if (!isDone || !isShared || !rootId) return;
        const created = getNodes(rootId).find((n) => !before.has(n.id) && n.kind === 'folder' && !n.parent);
        const shared = created && await shareCloudFolder(rootId, created);
        if (shared) setDialog({ type: 'share', container: shared });
      });
    }
    setDialog(undefined);
  });

  const handleSubmitMove = useLastCallback((target?: string, placeId?: string) => {
    if (dialog?.type === 'move') {
      if (placeId && placeId !== dialog.container) {
        void moveCloudNodesAcross(dialog.container, dialog.nodes, placeId, target);
      } else {
        void moveCloudNodes(dialog.container, dialog.nodes, target);
      }
    }
    setSelected([]);
    setDialog(undefined);
  });

  const handleConfirmShareFolder = useLastCallback(() => {
    if (dialog?.type !== 'shareFolder') return;
    const { entry } = dialog;
    setDialog(undefined);
    void shareCloudFolder(entry.container, entry.node).then((created) => {
      if (created) setDialog({ type: 'share', container: created });
    });
  });

  const handlePickFiles = useLastCallback(() => {
    fileInputRef.current?.click();
  });

  const handleFilesPicked = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) uploadCloudFiles(files);
  });

  // Перетаскивание: файлы с компьютера — в открытую папку, строки (компьютер) — на папку
  const drag = useCloudDrag({
    canUpload: canEdit && status !== 'needs-linking' && status !== 'loading',
    selected: selectedEntries,
    getEntry: (id, nodeId) => entries.find((e) => e.container === id && e.node.id === nodeId),
    canEdit: (id) => canEditContainer(id, data),
    nodesOf: (id) => getNodes(id, data),
    onUpload: uploadCloudFiles,
  });

  const handleSort = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const key = e.currentTarget.dataset.sort as CloudSortKey;
    const isSame = prefs.sort.key === key;
    setCloudPrefs({ sort: { key, isDescending: isSame ? !prefs.sort.isDescending : false } });
  });

  const handleNewFolder = useLastCallback(() => setDialog({ type: 'newFolder' }));

  // «+» навигации: загрузка файлов либо новая папка — в личный диск, если открыто место без своей папки
  const addRequest = useDerivedState(getModuleAddRequest);
  useEffect(() => {
    if (addRequest !== 'upload' && addRequest !== 'folder') return;
    consumeModuleAddRequest();
    if (!canEdit) setCloudPlace({});
    if (addRequest === 'upload') handlePickFiles();
    else handleNewFolder();
    // Запрос «+» разбирается один раз, когда пришёл: место на этот момент берётся как есть
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [addRequest]);
  const handleNewShared = useLastCallback(() => setDialog({ type: 'newShared' }));
  const handleEmptyTrash = useLastCallback(() => setDialog({ type: 'emptyTrash' }));
  const handleRevokeDead = useLastCallback(() => void revokeDeadCloudLinks());

  // «Доступ» в открытой общей папке: участники
  const handleAccess = useLastCallback(() => {
    if (container) setDialog({ type: 'share', container: container.id });
  });

  const statusKey = status === 'needs-linking' ? 'ParvaneCloudNeedsLinking'
    : status === 'no-key' ? 'ParvaneCloudSyncPending' : undefined;
  const statusTitleKey = status === 'needs-linking' ? 'ParvaneCloudStateNotLinked' : 'ParvaneCloudStateNoKey';
  const isBlocked = status === 'needs-linking' || status === 'loading';

  const isAlmostFull = getIsCloudAlmostFull(usage);
  const emptyKey = isSearch ? 'ParvaneCloudNothingFound'
    : isTrash ? 'ParvaneCloudEmptyTrash'
      : isSharedList ? 'ParvaneCloudEmptyShared'
        : isOwnedList ? 'ParvaneCloudEmptyOwned'
          : isLinksList ? 'ParvaneCloudLinksEmpty'
            : isRoot ? 'ParvaneCloudEmpty' : 'ParvaneCloudEmptyFolder';
  const moveContainer = dialog?.type === 'move' ? dialog.container : containerId;
  const moveRootName = !moveContainer || moveContainer === data?.rootId
    ? lang('ParvaneCloudTabDrive') : containerName(getContainer(moveContainer, data));
  // Один объект — «Переместить «имя»», несколько — общее название окна
  const moveTitle = dialog?.type === 'move' && dialog.nodes.length === 1
    ? lang('KnowledgeFilesMoveTitle', { name: dialog.nodes[0].name }) : undefined;
  const listedFolders = isRoot || isOwnedList ? ownedFolders : isSharedList ? sharedFolders : undefined;
  const shownInvites = isSharedList ? invites : undefined;
  const deadLinks = (links || []).filter((l) => l.state !== 'active').length;
  const hasRows = entries.length > 0 || Boolean(listedFolders?.length) || Boolean(shownInvites?.length)
    || (isLinksList && Boolean(links?.length));
  const canAdd = !isBlocked && canEdit;
  const isPersonalRoot = !place.view && !place.container && !place.folder;
  const isVault = (entry: Entry) => entry.container === data?.rootId && entry.node.kind === 'folder'
    && !entry.node.parent && VAULT_NAMES.includes(entry.node.name);
  // Файлы открытой папки — между ними листает просмотр
  const previewSiblings = entries.filter((entry) => entry.node.kind === 'file');
  const navPlace: CloudNavPlace = place.view || 'drive';
  const hasFileColumns = !isTrash && !isLinksList && !isOwnedList && !isSharedList;
  // Строки тащат мышью на компьютере; на телефоне перенос — выделением и «Переместить»
  const canDragRows = !isNarrow && !IS_TOUCH_ENV && !isTrash;

  const dayText = (seconds: number) => new Date(seconds * 1000)
    .toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '');

  /** Колонка «Доступ»: ссылка со сроком, участники общей папки либо «только я». */
  const accessText = (entry: Entry) => {
    const link = linkOfSource(links, { container: entry.container, node: entry.node.id });
    if (link?.state === 'active') {
      return link.expiresAt
        ? lang('ParvaneCloudAccessLinkUntil', { date: dayText(link.expiresAt) }) : lang('ParvaneCloudAccessLink');
    }
    const c = getContainer(entry.container, data);
    if (!c || c.kind === 'root') return lang('KnowledgeFilesOnlyYou');
    if (c.kind !== 'owned') return lang('KnowledgeFilesFrom', { name: peerLabel(c.owner) });
    return c.members.length ? lang('KnowledgeFilesSharedWith', { count: c.members.length })
      : lang('KnowledgeFilesOnlyYou');
  };

  const menuNode = menu?.type === 'node' ? menu.entry.node : undefined;
  const menuTitle = !menu ? undefined
    : menu.type === 'node' ? menu.entry.node.name : containerName(getContainer(menu.id, data));
  const menuFacts = menuNode && menuNode.kind === 'file' ? [
    fileTypeLabel(menuNode.name).toLowerCase(),
    formatFileSize(lang, menuNode.size),
    menuNode.mtime ? dayText(menuNode.mtime / 1000) : '',
  ].filter(Boolean).join(' · ') : undefined;

  const menuActions = (): CloudMenuAction[] => {
    if (!menu) return [];
    const item = (
      key: CloudItemAction | ContainerAction, icon: CloudMenuAction['icon'], title: string, isDanger?: boolean,
      hint?: string,
    ): CloudMenuAction => ({
      key, icon, title, isDanger, hint,
    });
    if (menu.type === 'container') {
      const isOwned = getContainer(menu.id, data)?.kind === 'owned';
      return [
        item('open', 'folder', lang('Open')),
        isOwned ? item('access', 'users', lang('ParvaneCloudShare'))
          : item('leave', 'x', lang('ParvaneCloudLeave'), true),
      ];
    }
    const { entry } = menu;
    const isFolder = entry.node.kind === 'folder';
    if (entry.node.trashed) {
      return [
        item('restore', 'restore', lang('ParvaneCloudRestore')),
        item('purge', 'trash', lang('ParvaneCloudDeleteForever'), true),
      ];
    }
    const canEditThis = canEditEntry(entry);
    const isFixed = isVault(entry);
    const link = linkOfSource(links, { container: entry.container, node: entry.node.id });
    const linkHint = link?.state !== 'active' ? undefined
      : link.expiresAt ? lang('ParvaneCloudLinkStateUntil', { date: dayText(link.expiresAt) })
        : lang('ParvaneCloudLinkStateForever');
    return [
      item('open', isFolder ? 'folder' : 'eye', lang(isFolder ? 'Open' : 'ParvaneCloudView')),
      !isFolder && item(
        'download', 'download', lang('ParvaneCloudDownload'), undefined, formatFileSize(lang, entry.node.size),
      ),
      // Ссылка для людей без аккаунта (spec 022): личный диск либо совместная папка с правом правки
      canEditThis && item('link', 'link', lang('ParvaneCloudLink'), undefined, linkHint),
      isFolder && canEditThis && entry.container === data?.rootId
      && item('share', 'users', lang('KnowledgeFilesShareOpen')),
      canEditThis && item('rename', 'edit', lang('ParvaneCloudRename')),
      canEditThis && !isFixed && item('move', 'move', lang('ParvaneCloudMove')),
      canEditThis && !isFixed && item('copy', 'copy', lang('ParvaneCloudMakeCopy')),
      !isFolder && item('send', 'chat', lang('ParvaneCloudSendToChat')),
      !isFolder && canAttachToNote && item('note', 'note', lang('ParvaneCloudAttachToNote')),
      IS_TOUCH_ENV && item('select', 'check', lang('ParvaneCloudSelect')),
      canEditThis && !isFixed && item('delete', 'trash', lang('ParvaneCloudToTrash'), true),
    ].filter((action): action is CloudMenuAction => Boolean(action));
  };

  // Ступень пути принимает перетащенные строки, если за ней папка (`dropFolder` — пусто у корня контейнера)
  function renderCrumb(
    key: string, title: string, onClick: NoneToVoidFunction, isFirst?: boolean, dropFolder?: string,
  ) {
    return (
      <span key={key} className={styles.pathStep}>
        {!isFirst && <i className={styles.pathSlash} aria-hidden="true">/</i>}
        <button
          type="button"
          className={styles.pathLink}
          data-drop-container={dropFolder !== undefined ? containerId : undefined}
          data-drop-folder={dropFolder || undefined}
          data-drop-name={title}
          onClick={onClick}
        >
          {title}
        </button>
      </span>
    );
  }

  function renderPath(className?: string) {
    return (
      <nav className={buildClassName(styles.path, className)} aria-label={lang('ParvaneCloudPath')}>
        {renderCrumb(
          'place', place.view ? virtualName(place.view) : lang('ParvaneCloudTabDrive'), handleOpenView, true,
          place.view ? undefined : '',
        )}
        {container && renderCrumb(container.id, containerName(container), () => handleOpenFolder(), undefined, '')}
        {path.map((n) => renderCrumb(n.id, n.name, () => handleOpenFolder(n.id), undefined, n.id))}
      </nav>
    );
  }

  function renderChip(title: string, onClick: NoneToVoidFunction, isDanger?: boolean) {
    return (
      <button type="button" className={buildClassName(kit.chip, isDanger && styles.chipDanger)} onClick={onClick}>
        {title}
      </button>
    );
  }

  function renderSelection() {
    const bytes = selectedEntries.reduce((sum, e) => sum + e.node.size, 0);
    const hasFilesSelected = selectedEntries.some((e) => e.node.kind === 'file');
    return (
      <div className={styles.selection} role="toolbar" aria-label={lang('ParvaneCloudSelect')}>
        <span className={styles.selectionCount}>
          <span>{lang('ParvaneCloudSelected', { count: selectedEntries.length })}</span>
          {bytes > 0 && <span>{` · ${formatFileSize(lang, bytes)}`}</span>}
        </span>
        {isTrash ? (
          <>
            {renderChip(lang('ParvaneCloudRestore'), handleBulkRestore)}
            {renderChip(lang('ParvaneCloudDeleteForever'), handleBulkPurge, true)}
          </>
        ) : (
          <>
            {hasFilesSelected && renderChip(lang('ParvaneCloudDownload'), handleBulkDownload)}
            {selectionContainer && renderChip(lang('ParvaneCloudMove'), handleBulkMove)}
            {hasFilesSelected && renderChip(lang('ParvaneCloudSendToChat'), handleBulkSend)}
            {editableSelection.length > 0 && renderChip(lang('ParvaneCloudToTrash'), handleBulkDelete, true)}
          </>
        )}
        {renderChip(lang('ParvaneCloudClearSelection'), handleClearSelection)}
      </div>
    );
  }

  // Строка под названием места: сколько там и что с этим делают
  const placeNote = isTrash ? lang('ParvaneCloudTrashCount', { count: trash.length })
    : isLinksList ? lang('ParvaneCloudLinksCount', { count: links?.length || 0 })
      : isOwnedList ? lang('ParvaneCloudOwnedNote')
        : isSharedList ? lang('ParvaneCloudSharedNote') : undefined;
  const placeAction = isTrash && trash.length > 0
    ? { title: lang('ParvaneCloudEmptyTrashAction'), onClick: handleEmptyTrash, isDanger: true }
    : isLinksList && deadLinks > 0
      ? {
        title: lang('ParvaneCloudLinksRemoveDead', { count: deadLinks }), onClick: handleRevokeDead, isDanger: false,
      }
      : isOwnedList && !isBlocked
        ? { title: lang('ParvaneCloudNewShared'), onClick: handleNewShared, isDanger: false } : undefined;

  function renderSortButton(key: CloudSortKey) {
    const isOn = prefs.sort.key === key;
    return (
      <button
        type="button"
        className={buildClassName(
          isNarrow ? kit.chip : styles.columnSort, isOn && (isNarrow ? kit.chipOn : styles.columnSortOn),
        )}
        aria-label={lang(SORT_TITLE_KEYS[key])}
        aria-pressed={isOn}
        data-sort={key}
        onClick={handleSort}
      >
        {lang(SORT_SHORT_KEYS[key])}
        {isOn && <PvIcon name={prefs.sort.isDescending ? 'down' : 'up'} isSmall />}
      </button>
    );
  }

  function renderColumns() {
    if (isNarrow || !hasRows) return undefined;
    if (!hasFileColumns) {
      return (
        <div className={styles.columns}>
          <span className={styles.columnName}>{lang('ParvaneCloudName')}</span>
          <span className={styles.cellWide}>
            {lang(
              isTrash ? 'ParvaneCloudColumnDeleted'
                : isLinksList ? 'ParvaneCloudColumnState' : 'ParvaneCloudColumnAccess',
            )}
          </span>
          <span className={styles.cellSize}>{lang('ParvaneCloudSize')}</span>
          {(isTrash || isLinksList) && <span className={styles.cellActions} />}
          {isOwnedList && <span className={styles.cellMenu} />}
          {!isLinksList && <span className={styles.cellMenu} />}
        </div>
      );
    }
    return (
      <div className={styles.columns}>
        <span className={styles.columnName}>{renderSortButton('name')}</span>
        <span className={styles.cellAccess}>{lang('ParvaneCloudColumnAccess')}</span>
        <span className={styles.cellDate}>{renderSortButton('date')}</span>
        <span className={styles.cellSize}>{renderSortButton('size')}</span>
        <span className={styles.cellMenu} />
      </div>
    );
  }

  const usageBlock = usage && usage.quota > 0
    ? <CloudUsage usage={usage} trashBytes={sizes.trash} isInList={isNarrow} /> : undefined;

  return (
    <div
      id="ParvaneCloud"
      className={styles.root}
      data-sync-status={status}
      data-loaded={isLoaded ? '1' : '0'}
      data-place={isVirtual ? place.view : 'drive'}
      onDragStart={drag.handlers.onDragStart}
      onDragEnd={drag.handlers.onDragEnd}
      onDragEnter={drag.handlers.onDragEnter}
      onDragOver={drag.handlers.onDragOver}
      onDragLeave={drag.handlers.onDragLeave}
      onDrop={drag.handlers.onDrop}
    >
      {isShown && <SectionHistoryBack onBack={handleHistoryBack} />}
      <CloudNav
        place={navPlace}
        counts={navCounts}
        driveId={data?.rootId}
        footer={isNarrow ? undefined : usageBlock}
        onPick={handleNav}
      />
      <header className={styles.head}>
        {selectedEntries.length > 0 ? renderSelection() : (
          <>
            {isNarrow ? (
              !isSearchShown && <h1 className={styles.headTitle}>{lang('ParvaneModuleFiles')}</h1>
            ) : (
              <div className={styles.headText}>
                {isSearch ? (
                  <h2 className={styles.headTitle} data-found={entries.length}>
                    {lang('ParvaneCloudFound', { count: entries.length })}
                  </h2>
                ) : renderPath()}
                {placeNote && <div className={styles.headSub}>{placeNote}</div>}
              </div>
            )}
            {!isBlocked && (
              <PvHeaderSearch
                value={query}
                label={lang('ParvaneCloudSearch')}
                isOpen={isSearchShown}
                onOpen={openSearch}
                onClose={handleSearchClose}
                onChange={setQuery}
              />
            )}
            {!isNarrow && placeAction && (
              <button
                type="button"
                className={buildClassName(kit.btn, styles.headButton, placeAction.isDanger && styles.chipDanger)}
                onClick={placeAction.onClick}
              >
                {placeAction.title}
              </button>
            )}
            {!isNarrow && canAdd && !current && (
              <button type="button" className={buildClassName(kit.btn, styles.headButton)} onClick={handleNewFolder}>
                {lang('ParvaneCloudNewFolder')}
              </button>
            )}
            {!isNarrow && canAdd && (
              <button
                type="button"
                className={buildClassName(kit.btn, kit.btnAcc, styles.headButton)}
                onClick={handlePickFiles}
              >
                <PvIcon name="upload" isSmall />
                {lang('ParvaneCloudUpload')}
              </button>
            )}
          </>
        )}
      </header>
      <div className={buildClassName(styles.body, 'custom-scroll')}>
        {isOffline && <PvOfflineBar text={lang('PvOfflineFiles')} onRetry={retryCloud} />}
        {isNarrow && !isSearch && !isVirtual && renderPath(styles.pathInList)}
        {statusKey && (
          <div className={styles.strip} role="status">
            <span className={buildClassName(styles.dot, isBlocked ? styles.dotBad : undefined)} />
            <span className={styles.stripText}>
              <span className={styles.stripTitle}>{lang(statusTitleKey)}</span>
              {lang(statusKey)}
            </span>
          </div>
        )}
        {isAlmostFull && usage && !isTrash && (
          <div className={styles.strip} role="status" data-usage-warning>
            <span className={buildClassName(styles.dot, styles.dotBad)} />
            <span className={styles.stripText}>
              {lang('ParvaneCloudAlmostFull', {
                used: formatFileSize(lang, usage.used), total: formatFileSize(lang, usage.quota),
              })}
            </span>
            <button type="button" className={styles.textButton} onClick={handleOpenTrash}>
              {lang('ParvaneCloudFreeUp')}
            </button>
          </div>
        )}
        {!isBlocked && !isSearch && container && (container.kind === 'owned' ? (
          <button
            type="button"
            className={buildClassName(styles.strip, styles.stripButton)}
            data-share-banner="owned"
            onClick={handleAccess}
          >
            <PvIcon name="users" isSmall className={styles.stripIcon} />
            <span className={styles.stripText}>
              {container.members.length
                ? lang('KnowledgeFilesSharedBanner', {
                  name: containerName(container),
                  members: container.members.map((m) => peerLabel(m.user)).join(', '),
                })
                : lang('KnowledgeFilesSharedBannerAlone', { name: containerName(container) })}
            </span>
          </button>
        ) : (
          <div className={styles.strip} data-share-banner="shared">
            <PvIcon name="users" isSmall className={styles.stripIcon} />
            <span className={styles.stripText}>
              {lang('KnowledgeFilesIncomingBanner', {
                name: containerName(container),
                owner: peerLabel(container.owner),
                rights: lang(container.role === 'editor' ? 'KnowledgeFilesCanEdit' : 'KnowledgeFilesViewOnly'),
              })}
            </span>
          </div>
        ))}
        {isNarrow && isSearchShown && !isBlocked && (
          <>
            <h3 className={styles.caption}>{lang('ParvaneCloudSort')}</h3>
            <div className={buildClassName(kit.chips, styles.hint)}>{SORT_KEYS.map(renderSortButton)}</div>
          </>
        )}
        {isSearch && isNarrow && (
          <h3 className={styles.caption} data-found={entries.length}>
            {lang('ParvaneCloudFound', { count: entries.length })}
          </h3>
        )}
        {isNarrow && placeNote && !isBlocked && (
          <div className={styles.hint}>
            {isTrash ? lang('ParvaneCloudTrashNote') : placeNote}
          </div>
        )}
        {isNarrow && placeAction && (
          <button
            type="button"
            className={buildClassName(styles.strip, styles.stripButton, placeAction.isDanger && styles.chipDanger)}
            onClick={placeAction.onClick}
          >
            {placeAction.title}
          </button>
        )}
        {!isLoaded && status !== 'needs-linking' && <PvSkeleton onRetry={isOffline ? undefined : retryCloud} />}
        {isLoaded && renderColumns()}
        {isLoaded && (
          <div className={styles.list} role="list">
            {shownInvites?.map((c) => <CloudInviteCard key={c.id} info={c} />)}
            <CloudTransfers />
            {listedFolders?.map((c) => (
              <CloudContainerRow
                key={c.id}
                info={c}
                count={childrenOf(listedNodes(getNodes(c.id, data))).length}
                isNarrow={isNarrow}
                hasFileColumns={hasFileColumns}
                onOpen={handleOpenContainer}
                onAccess={handleContainerAccess}
                onMenu={handleContainerMenu}
              />
            ))}
            {isLinksList && links?.map((link) => (
              <CloudLinkRow key={link.id} link={link} isNarrow={isNarrow} onOpen={handleOpenLink} />
            ))}
            {entries.map((entry) => {
              const daysLeft = isTrash ? trashDaysLeft(entry.node, now) : undefined;
              const stats = entry.node.kind === 'folder'
                ? statsByContainer.get(entry.container)?.get(entry.node.id) || NO_CHILDREN : undefined;
              return (
                <CloudItem
                  key={keyOf(entry)}
                  container={entry.container}
                  node={entry.node}
                  accessText={accessText(entry)}
                  hint={isSearch ? pathText(entry) : undefined}
                  trashHint={daysLeft === undefined ? undefined
                    : daysLeft ? lang('ParvaneCloudTrashDaysLeft', { count: daysLeft }, { pluralValue: daysLeft })
                      : lang('ParvaneCloudTrashExpired')}
                  daysLeft={daysLeft}
                  childCount={stats?.count}
                  folderSize={stats?.size}
                  isSelected={selected.includes(keyOf(entry))}
                  isSelecting={selected.length > 0}
                  isCurrent={current ? keyOf(current) === keyOf(entry) : undefined}
                  isTrash={isTrash}
                  isNarrow={isNarrow}
                  isVault={isVault(entry)}
                  isIncoming={getContainer(entry.container, data)?.kind === 'shared'}
                  isDraggable={canDragRows && canEditEntry(entry) && !isVault(entry)}
                  isDropTarget={!isTrash && canEditEntry(entry)}
                  onOpen={handleOpen}
                  onToggle={handleToggle}
                  onMenu={handleMenu}
                  onAction={handleAction}
                />
              );
            })}
          </div>
        )}
        {isLoaded && !hasRows && !hasTransfers && (
          <PvEmpty
            title={lang(emptyKey)}
            text={emptyKey === 'ParvaneCloudNothingFound' ? undefined : lang(EMPTY_HINT_KEYS[emptyKey])}
            actionText={canAdd && !isSearch ? lang('ParvaneCloudUpload') : undefined}
            data-cloud-empty={emptyKey}
            onAction={handlePickFiles}
          />
        )}
        {isLoaded && hasRows && !isNarrow && (
          <div className={styles.hint}>
            {canAdd ? lang('ParvaneCloudDropHint')
              : isTrash ? lang('ParvaneCloudTrashNote')
                : isLinksList ? lang('ParvaneCloudLinksNote')
                  : isSharedList ? lang('ParvaneCloudSharedHint') : undefined}
          </div>
        )}
        {isNarrow && usageBlock}
        {drag.rowDrag && (
          <div className={dragStyles.toast} role="status" data-cloud-drag-hint>
            {drag.rowDrag.target
              ? lang('ParvaneCloudDragOnto', { name: drag.rowDrag.target }) : lang('ParvaneCloudDragHint')}
          </div>
        )}
        {notice && (
          <div className={styles.notice} role="alert" onClick={hideCloudNotice}>
            {notice.code === 'saved' ? lang('ParvaneCloudSavedToCloud')
              : notice.code === 'sent' ? lang('ParvaneCloudSentToChat') : lang(CLOUD_ERROR_KEYS[notice.code])}
          </div>
        )}
      </div>
      {drag.uploadCount !== undefined && (
        <CloudDropZone
          place={dropPlaceTitle(
            place.view ? virtualName(place.view) : lang('ParvaneCloudTabDrive'),
            container && containerName(container),
            nodes,
            place.folder,
          )}
          count={drag.uploadCount}
        />
      )}
      {current && (
        <CloudDetail
          container={current.container}
          node={current.node}
          link={linkOfSource(links, { container: current.container, node: current.node.id })}
          canEdit={canEditEntry(current)}
          onAction={handleAction}
        />
      )}
      <input
        ref={fileInputRef}
        className={styles.fileInput}
        type="file"
        multiple
        aria-label={lang('ParvaneCloudUpload')}
        onChange={handleFilesPicked}
      />
      <CloudMenu
        isOpen={Boolean(menu)}
        title={menuTitle}
        facts={menuFacts}
        actions={menuActions()}
        anchor={menu?.anchor}
        onPick={handleMenuPick}
        onClose={handleCloseMenu}
      />
      <CloudNameDialog
        isOpen={dialog?.type === 'newFolder' || dialog?.type === 'rename'}
        title={lang(dialog?.type === 'rename' ? 'ParvaneCloudRename' : 'ParvaneCloudNewFolder')}
        label={lang(dialog?.type === 'rename' ? 'ParvaneCloudNewName' : 'ParvaneCloudFolderName')}
        confirmLabel={lang(dialog?.type === 'rename' ? 'ParvaneCloudSave' : 'ParvaneCloudCreate')}
        initialName={dialog?.type === 'rename' ? dialog.entry.node.name : undefined}
        canShare={dialog?.type === 'newFolder' && isPersonalRoot}
        onSubmit={handleSubmitName}
        onClose={handleCloseDialog}
      />
      <CloudFolderDialog
        isOpen={dialog?.type === 'move'}
        title={moveTitle}
        rootName={moveRootName}
        nodes={dialog?.type === 'move' ? getNodes(dialog.container, data) : nodes}
        movedIds={dialog?.type === 'move' ? dialog.nodes.map((n) => n.id) : []}
        startFolder={moveContainer === containerId ? place.folder : undefined}
        places={movePlaces}
        sourcePlace={dialog?.type === 'move' ? dialog.container : undefined}
        onSubmit={handleSubmitMove}
        onClose={handleCloseDialog}
      />
      <ConfirmDialog
        isOpen={dialog?.type === 'purge' || dialog?.type === 'emptyTrash'}
        title={lang(dialog?.type === 'emptyTrash' ? 'ParvaneCloudEmptyTrashAction' : 'ParvaneCloudDeleteForever')}
        text={lang(
          dialog?.type === 'emptyTrash' ? 'ParvaneCloudEmptyTrashConfirm' : 'ParvaneCloudDeleteForeverConfirm',
        )}
        confirmLabel={lang('ParvaneCloudDeleteForever')}
        confirmIsDestructive
        confirmHandler={handleConfirmPurge}
        onClose={handleCloseDialog}
      />
      <ConfirmDialog
        isOpen={dialog?.type === 'shareFolder'}
        title={lang('ParvaneCloudShare')}
        text={lang('ParvaneCloudShareFolderConfirm', {
          name: dialog?.type === 'shareFolder' ? dialog.entry.node.name : '',
        })}
        confirmLabel={lang('ParvaneCloudShareFolderAction')}
        confirmHandler={handleConfirmShareFolder}
        onClose={handleCloseDialog}
      />
      <ConfirmDialog
        isOpen={dialog?.type === 'leave'}
        title={lang('ParvaneCloudLeave')}
        text={lang('ParvaneCloudLeaveConfirm')}
        confirmLabel={lang('ParvaneCloudLeave')}
        confirmIsDestructive
        confirmHandler={handleConfirmLeave}
        onClose={handleCloseDialog}
      />
      <CloudShareDialog
        isOpen={dialog?.type === 'share' || dialog?.type === 'newShared'}
        containerId={dialog?.type === 'share' ? dialog.container : undefined}
        onChanged={refreshCloud}
        onClose={handleCloseDialog}
      />
      <CloudLinkDialog target={dialog?.type === 'link' ? dialog.target : undefined} onClose={handleCloseDialog} />
      <CloudSendDialog
        entries={dialog?.type === 'send' ? dialog.entries : undefined}
        onClose={handleCloseDialog}
      />
      <CloudNoteDialog entry={dialog?.type === 'note' ? dialog.entry : undefined} onClose={handleCloseDialog} />
      <CloudPreview
        container={preview?.container}
        node={preview?.node}
        maxBytes={isMobile ? PREVIEW_MAX_BYTES_MOBILE : PREVIEW_MAX_BYTES_DESKTOP}
        siblings={previewSiblings}
        isNarrow={isNarrow}
        canEdit={preview ? canEditEntry(preview) : undefined}
        onNavigate={handlePreviewNavigate}
        onAction={handlePreviewAction}
        onMore={isNarrow ? handlePreviewMore : undefined}
        onClose={handleClosePreview}
      />
    </div>
  );
};

export default memo(Cloud);
