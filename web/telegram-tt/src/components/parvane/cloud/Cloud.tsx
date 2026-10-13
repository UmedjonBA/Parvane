import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudLinkInfo } from '../../../api/parvane/cloudDrive';
import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { GlobalState } from '../../../global/types';
import type { CloudMovePlace } from './CloudDialogs';
import type { CloudItemAction } from './CloudItem';
import type { CloudLinkTarget } from './CloudLinkDialog';
import type { CloudMenuAction } from './CloudMenu';
import type { CloudNode, CloudSortKey } from './cloudModel';
import type { CloudPlace, CloudVirtualFolder } from './cloudStore';

import { IS_TOUCH_ENV, MAX_BUFFER_SIZE } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { SEARCH_FIELD_PROPS } from '../../../util/searchField';
import { formatFileSize } from '../../../util/textFormat';
import { openPalette } from '../palette/paletteOpen';
import {
  childrenOf, folderStats, listedNodes, pathOf, searchNodes, sortNodes, trashDaysLeft, usageOf,
} from './cloudModel';
import {
  answerCloudInvite, canEditContainer, createCloudFolder, downloadCloudNode, emptyCloudTrash, getActiveContainerId,
  getCloudData, getCloudLinks, getCloudNotice, getCloudPlace, getCloudPrefs, getCloudStatus, getCloudUsage,
  getContainer, getHasCloudTransfers, getIsCloudLoaded, getNodes, getTrash, hideCloudNotice, leaveCloudFolder,
  loadCloud, moveCloudNodes, moveCloudNodesAcross, purgeCloudNodes, refreshCloud, refreshCloudLinks, renameCloudNode,
  restoreCloudNodes, setCloudActive, setCloudPlace, setCloudPrefs, shareCloudFolder, trashCloudNodes, uploadCloudFiles,
} from './cloudStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import DropdownMenu from '../../ui/DropdownMenu';
import Loading from '../../ui/Loading';
import MenuItem from '../../ui/MenuItem';
import SearchForm from '../../ui/SearchForm';
import KnowledgeTabs from '../notes/KnowledgeTabs';
import PvIcon from '../notes/PvIcon';
import { CloudFolderDialog, CloudNameDialog } from './CloudDialogs';
import CloudItem from './CloudItem';
import CloudLinkDialog from './CloudLinkDialog';
import CloudMenu from './CloudMenu';
import CloudPreview from './CloudPreview';
import CloudSendDialog from './CloudSendDialog';
import CloudShareDialog from './CloudShareDialog';
import CloudTransfers, { CLOUD_ERROR_KEYS } from './CloudTransfers';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type OwnProps = {
  isMobile?: boolean;
};

type Entry = { container: string; node: CloudNode };
// Чьё меню «⋯» открыто: файла либо папки дерева или строки совместной папки
type MenuTarget = { type: 'node'; entry: Entry } | { type: 'container'; id: string };
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
  | { type: 'send'; entries: Entry[] };

const SORT_KEYS: CloudSortKey[] = ['name', 'date', 'size'];
// Просмотр держит файл в памяти: на телефоне предел ниже
const PREVIEW_MAX_BYTES_DESKTOP = 256 * 1024 * 1024;
const PREVIEW_MAX_BYTES_MOBILE = 64 * 1024 * 1024;
const USAGE_WARN_SHARE = 0.9;
// Поиск по всем папкам применяется с задержкой после ввода, а не на каждую букву
const SEARCH_DEBOUNCE_MS = 150;
const NO_CHILDREN = { count: 0, size: 0 };
// Папка хранилища заметок в корне личного диска (названия — как в `notes/notesStore.ts`)
const VAULT_NAMES = ['Знания', 'Knowledge'];
const SORT_SHORT_KEYS = {
  name: 'ParvaneCloudName', date: 'ParvaneCloudModified', size: 'ParvaneCloudSize',
} as const;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

function keyOf(entry: Entry) {
  return `${entry.container}/${entry.node.id}`;
}

function nameOf(address: string) {
  return address.split('@')[0];
}

// Parvane (spec 016): «Файлы» — личное файловое хранилище одним списком по прототипу (`vCloud`): поиск по
// всем папкам и сортировка, путь, приглашения строкой вверху корня, строки с цветной плиткой и «⋯»,
// в конце корня — строки-папки «Доступные мне» и «Корзина», внизу строка о занятом месте. Действия,
// просмотр, перенос и доступ — шторки. Дерево — контейнеры домена `cloud.v1` (cloudStore), содержимое
// файлов сервер не видит.
const Cloud = ({ isMobile }: OwnProps) => {
  const lang = useLang();

  const data = useDerivedState(getCloudData);
  const isLoaded = useDerivedState(getIsCloudLoaded);
  const status = useDerivedState(getCloudStatus);
  const place = useDerivedState(getCloudPlace);
  const prefs = useDerivedState(getCloudPrefs);
  // Сам ход переносов показывает `CloudTransfers`; здесь нужно лишь знать, есть ли они
  const hasTransfers = useDerivedState(getHasCloudTransfers);
  const usage = useDerivedState(getCloudUsage);
  const notice = useDerivedState(getCloudNotice);
  const links = useDerivedState(getCloudLinks);

  const [query, setQuery] = useState('');
  // Запрос, по которому строится список: с задержкой после ввода, очистка — сразу
  const [appliedQuery, setAppliedQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog>();
  const [preview, setPreview] = useState<Entry>();
  const [menu, setMenu] = useState<MenuTarget>();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>();
  const dragDepthRef = useRef(0);

  const currentUserId = useSelector(selectCurrentUserId);

  useEffect(() => {
    void loadCloud(currentUserId);
  }, [currentUserId]);

  // Пока раздел открыт, сервер опрашивается часто; закрыт — редко
  useEffect(() => {
    setCloudActive(true);
    return () => setCloudActive(false);
  }, []);

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
  const isLinksList = !isSearch && isVirtual && place.view === 'links';
  const isRoot = !isSearch && !place.view && !place.container && !place.folder;
  const containerId = isVirtual ? undefined : getActiveContainerId(place, data);
  const container = getContainer(place.container, data);
  const nodes = getNodes(containerId, data);
  // Загружать и создавать можно в открытой папке; строки-папки корня только показывают
  const canEdit = !isVirtual && canEditContainer(place.container, data);

  // «Мои ссылки» перечитываются при каждом открытии: срок мог истечь, ссылку могло создать другое устройство
  useEffect(() => {
    if (isLinksList) void refreshCloudLinks();
  }, [isLinksList]);

  // Выделение сбрасывается при смене места и запроса
  useEffect(() => {
    setSelected([]);
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
    if (isSharedList || !containerId) return [];
    // Служебные файлы Parvane (отметка справки в хранилище заметок) в списке не показываются
    return sortNodes(childrenOf(listedNodes(nodes), place.folder), prefs.sort)
      .map((node) => ({ container: containerId, node }));
  }, [trimmedQuery, allContainers, data, prefs.sort, isTrash, trash, isSharedList, containerId, nodes, place.folder]);

  // Куда можно переносить: личный диск и совместные папки с правом записи
  const movePlaces: CloudMovePlace[] = useMemo(() => (
    (allContainers || [])
      .filter((c) => c.kind !== 'invite' && (c.role === 'owner' || c.role === 'editor'))
      .map((c) => ({
        id: c.id,
        name: c.kind === 'root' ? lang('ParvaneSectionCloud') : c.name || lang('ParvaneCloudSharedFolder'),
        isShared: c.kind !== 'root',
        nodes: getNodes(c.id, data),
      }))
  ), [allContainers, data, lang]);

  const selectedEntries = entries.filter((e) => selected.includes(keyOf(e)));
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
  const virtualName = (view: CloudVirtualFolder) => lang(
    view === 'shared' ? 'ParvaneCloudTabShared' : view === 'links' ? 'ParvaneCloudLinks' : 'ParvaneCloudTabTrash',
  );

  /** Место узла: чужая папка лежит под «Доступными мне», остальное — прямо в корне. */
  const placeOf = (id: string, folder?: string): CloudPlace => {
    if (id === data?.rootId) return { folder };
    return { view: getContainer(id, data)?.kind === 'shared' ? 'shared' : undefined, container: id, folder };
  };

  /** Путь до папки узла словами — подпись найденного. */
  const pathText = (entry: Entry) => {
    const entryPlace = placeOf(entry.container);
    return [
      lang('ParvaneSectionCloud'),
      ...(entryPlace.view ? [virtualName(entryPlace.view)] : []),
      ...(entryPlace.container ? [containerName(getContainer(entryPlace.container, data))] : []),
      ...pathOf(getNodes(entry.container, data), entry.node.parent || undefined).map((n) => n.name),
    ].join(' / ');
  };

  const goTo = (next: CloudPlace) => {
    setQuery('');
    setCloudPlace(next);
  };

  const handleQueryChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  });

  const handleOpenRoot = useLastCallback(() => goTo({}));

  const handleOpenFolder = useLastCallback((folder?: string) => {
    goTo({ view: place.view, container: place.container, folder });
  });

  const handleOpenContainer = useLastCallback((id: string) => goTo(placeOf(id)));

  const handleOpen = useLastCallback((entryContainer: string, node: CloudNode) => {
    if (node.kind === 'folder') {
      goTo(placeOf(entryContainer, node.id));
      return;
    }
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
    if (action === 'open') handleOpen(entryContainer, node);
    if (action === 'download') handleDownload(entryContainer, node);
    if (action === 'rename') setDialog({ type: 'rename', entry });
    if (action === 'move') setDialog({ type: 'move', container: entryContainer, nodes: [node] });
    if (action === 'delete') void trashCloudNodes(entryContainer, [node]);
    if (action === 'restore') void restoreCloudNodes(entryContainer, [node]);
    if (action === 'purge') setDialog({ type: 'purge', entries: [entry] });
    if (action === 'send') setDialog({ type: 'send', entries: [entry] });
    if (action === 'share') setDialog({ type: 'shareFolder', entry });
    if (action === 'link') {
      setDialog({ type: 'link', target: { source: { container: entryContainer, node: node.id, name: node.name } } });
    }
  });

  const handleMenu = useLastCallback((entryContainer: string, node: CloudNode) => {
    setMenu({ type: 'node', entry: { container: entryContainer, node } });
  });

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

  const handlePreviewSend = useLastCallback((entryContainer: string, node: CloudNode) => {
    setPreview(undefined);
    setDialog({ type: 'send', entries: [{ container: entryContainer, node }] });
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

  const handleSubmitName = useLastCallback((name: string) => {
    if (dialog?.type === 'newFolder') void createCloudFolder(name);
    if (dialog?.type === 'rename') void renameCloudNode(dialog.entry.container, dialog.entry.node, name);
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

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');

  const handleDragEnter = useLastCallback((e: React.DragEvent) => {
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  });

  const handleDragOver = useLastCallback((e: React.DragEvent) => {
    if (canEdit && hasFiles(e)) e.preventDefault();
  });

  const handleDragLeave = useLastCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setIsDragging(false);
  });

  const handleDrop = useLastCallback((e: React.DragEvent) => {
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) uploadCloudFiles(files);
  });

  const handleSort = (key: CloudSortKey) => () => {
    const isSame = prefs.sort.key === key;
    setCloudPrefs({ sort: { key, isDescending: isSame ? !prefs.sort.isDescending : false } });
  };

  const handleNewFolder = useLastCallback(() => setDialog({ type: 'newFolder' }));
  const handleNewShared = useLastCallback(() => setDialog({ type: 'newShared' }));
  const handleEmptyTrash = useLastCallback(() => setDialog({ type: 'emptyTrash' }));

  // «Доступ» в открытой папке: у совместной — участники, у папки личного диска — предложение сделать её совместной
  const handleAccess = useLastCallback(() => {
    if (container) {
      setDialog({ type: 'share', container: container.id });
      return;
    }
    const folder = containerId && place.folder ? nodes.find(({ id }) => id === place.folder) : undefined;
    if (folder && containerId) setDialog({ type: 'shareFolder', entry: { container: containerId, node: folder } });
  });

  const statusKey = status === 'needs-linking' ? 'ParvaneCloudNeedsLinking'
    : status === 'offline' ? 'ParvaneCloudSyncUnavailable'
      : status === 'no-key' ? 'ParvaneCloudSyncPending' : undefined;
  const isBlocked = status === 'needs-linking' || status === 'loading';
  const sortTitles = {
    name: lang('ParvaneCloudSortName'), date: lang('ParvaneCloudSortDate'), size: lang('ParvaneCloudSortSize'),
  };

  const SortButton = ({ onTrigger, isOpen }: { onTrigger: () => void; isOpen?: boolean }) => (
    <button
      type="button"
      className={buildClassName(styles.sortPill, isOpen && styles.sortPillOpen)}
      aria-label={`${lang('ParvaneCloudSort')}: ${sortTitles[prefs.sort.key]}`}
      onClick={onTrigger}
    >
      {lang(SORT_SHORT_KEYS[prefs.sort.key])}
      <PvIcon name={prefs.sort.isDescending ? 'down' : 'up'} isSmall />
    </button>
  );

  const usedShare = usage?.quota ? usage.used / usage.quota : 0;
  const emptyKey = isSearch ? 'ParvaneCloudNothingFound'
    : isTrash ? 'ParvaneCloudEmptyTrash'
      : isSharedList ? 'ParvaneCloudEmptyShared'
        : isLinksList ? 'ParvaneCloudLinksEmpty'
          : isRoot ? 'ParvaneCloudEmpty' : 'ParvaneCloudEmptyFolder';
  const moveContainer = dialog?.type === 'move' ? dialog.container : containerId;
  const moveRootName = !moveContainer || moveContainer === data?.rootId
    ? lang('ParvaneSectionCloud') : containerName(getContainer(moveContainer, data));
  // Один объект — «Переместить «имя»», несколько — общее название окна
  const moveTitle = dialog?.type === 'move' && dialog.nodes.length === 1
    ? lang('KnowledgeFilesMoveTitle', { name: dialog.nodes[0].name }) : undefined;
  const listedFolders = isRoot ? ownedFolders : isSharedList ? sharedFolders : undefined;
  const hasRows = entries.length > 0 || Boolean(listedFolders?.length) || (isLinksList && Boolean(links?.length));
  const canAdd = !isBlocked && canEdit;
  const isPersonalRoot = !place.container && !place.folder;
  // «Доступ» для открытой папки: совместная папка либо папка личного диска, которую можно сделать совместной
  const hasAccessChip = canAdd && !isSearch && (Boolean(container) || Boolean(place.folder && !place.container));
  const roleText = (role?: string) => lang(role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')
    .toLocaleLowerCase();
  const itemsText = (count: number) => lang('KnowledgeFilesItems', { count }, { pluralValue: count });
  const isVault = (entry: Entry) => entry.container === data?.rootId && entry.node.kind === 'folder'
    && !entry.node.parent && VAULT_NAMES.includes(entry.node.name);
  // Файлы открытой папки — между ними листает просмотр
  const previewSiblings = entries.filter((entry) => entry.node.kind === 'file');

  const accessText = (id: string) => {
    const c = getContainer(id, data);
    if (!c || c.kind === 'root') return lang('KnowledgeFilesOnlyYou');
    if (c.kind !== 'owned') return lang('KnowledgeFilesFrom', { name: nameOf(c.owner) });
    return c.members.length ? c.members.map((m) => nameOf(m.user)).join(', ') : lang('KnowledgeFilesOnlyYou');
  };

  const menuTitle = !menu ? undefined
    : menu.type === 'node' ? menu.entry.node.name : containerName(getContainer(menu.id, data));

  const menuActions = (): CloudMenuAction[] => {
    if (!menu) return [];
    const item = (
      key: CloudItemAction | ContainerAction, icon: CloudMenuAction['icon'], title: string, isDanger?: boolean,
    ): CloudMenuAction => ({
      key, icon, title, isDanger,
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
    return [
      item('open', isFolder ? 'folder' : 'eye', lang(isFolder ? 'Open' : 'ParvaneCloudView')),
      !isFolder && item('download', 'download', lang('ParvaneCloudDownload')),
      isFolder && canEditThis && entry.container === data?.rootId
      && item('share', 'users', lang('KnowledgeFilesShareOpen')),
      // Ссылка для людей без аккаунта (spec 022): личный диск либо совместная папка с правом правки
      canEditThis && item('link', 'link', lang('ParvaneCloudLink')),
      !isFolder && item('send', 'chat', lang('ParvaneCloudSendToChat')),
      canEditThis && !isFixed && item('move', 'move', lang('ParvaneCloudMove')),
      canEditThis && item('rename', 'edit', lang('ParvaneCloudRename')),
      IS_TOUCH_ENV && item('select', 'check', lang('ParvaneCloudSelect')),
      canEditThis && !isFixed && item('delete', 'trash', lang('ParvaneCloudToTrash'), true),
    ].filter((action): action is CloudMenuAction => Boolean(action));
  };

  function renderInviteRow(c: CloudContainerInfo) {
    return (
      <div
        key={c.id}
        className={buildClassName(styles.plainRow, styles.inviteRow)}
        role="listitem"
        data-container-id={c.id}
        data-container-kind={c.kind}
        data-name={c.name}
      >
        <span className={buildClassName(kit.ava, kit.avaRound)} style="--c: var(--pv-purple)">
          {(Array.from(nameOf(c.owner))[0] || '').toUpperCase()}
        </span>
        <span className={buildClassName(kit.rowText, styles.inviteText)}>
          <span className={styles.inviteTitle} dir="auto">
            {lang('ParvaneCloudInviteFrom', { name: nameOf(c.owner), folder: containerName(c) })}
          </span>
          <span className={kit.sub} dir="auto">{roleText(c.role)}</span>
        </span>
        <span className={styles.inviteButtons}>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnGhost)}
            onClick={() => void answerCloudInvite(c.id, false)}
          >
            {lang('ParvaneCloudDecline')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            onClick={() => void answerCloudInvite(c.id, true)}
          >
            {lang('ParvaneCloudAccept')}
          </button>
        </span>
      </div>
    );
  }

  function renderContainerRow(c: CloudContainerInfo) {
    const isOwned = c.kind === 'owned';
    const count = childrenOf(listedNodes(getNodes(c.id, data))).length;
    return (
      <div
        key={c.id}
        className={buildClassName(kit.row, styles.item)}
        role="listitem"
        tabIndex={0}
        data-container-id={c.id}
        data-container-kind={c.kind}
        data-name={c.name}
        onClick={() => handleOpenContainer(c.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) handleOpenContainer(c.id);
        }}
      >
        <span className={kit.ava} style={`--c: var(--pv-${isOwned ? 'blue' : 'purple'})`}>
          <PvIcon name="folder" isSmall />
        </span>
        <span className={kit.rowText}>
          <span className={kit.ttl} dir="auto">{containerName(c)}</span>
          <span className={kit.sub} dir="auto">
            <span>{itemsText(count)}</span>
            {' · '}
            <span className={styles.shared}>
              {isOwned
                ? (c.members.length
                  ? lang('KnowledgeFilesSharedWith', { count: c.members.length })
                  : lang('KnowledgeFilesSharedAlone'))
                : `${lang('KnowledgeFilesFrom', { name: nameOf(c.owner) })} · ${roleText(c.role)}`}
            </span>
          </span>
        </span>
        {isOwned && (
          <button
            type="button"
            className={buildClassName(kit.ib, styles.sharedButton)}
            aria-label={lang('ParvaneCloudShare')}
            onClick={(e) => {
              e.stopPropagation();
              setDialog({ type: 'share', container: c.id });
            }}
          >
            <PvIcon name="users" isSmall />
          </button>
        )}
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('ParvaneCloudActions')}
          onClick={(e) => {
            e.stopPropagation();
            setMenu({ type: 'container', id: c.id });
          }}
        >
          <PvIcon name="dots" />
        </button>
      </div>
    );
  }

  function renderLinkRow(link: CloudLinkInfo) {
    const dateText = (seconds: number) => new Date(seconds * 1000)
      .toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '');
    const open = () => setDialog({ type: 'link', target: { linkId: link.id } });
    const term = link.state === 'preparing' ? lang('ParvaneCloudLinkUnfinished')
      : link.state === 'expired' ? lang('ParvaneCloudLinkStateExpired')
        : link.expiresAt ? lang('ParvaneCloudLinkStateUntil', { date: dateText(link.expiresAt) })
          : lang('ParvaneCloudLinkStateForever');
    return (
      <div
        key={link.id}
        className={buildClassName(kit.row, styles.item)}
        role="listitem"
        tabIndex={0}
        data-link-row={link.id}
        data-link-state={link.state}
        data-name={link.name}
        data-bytes={link.bytes}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter') open();
        }}
      >
        <span className={kit.ava} style={`--c: var(--pv-${link.state === 'active' ? 'blue' : 'muted'})`}>
          <PvIcon name={link.kind === 'folder' ? 'folder' : link.kind === 'file' ? 'file' : 'link'} isSmall />
        </span>
        <span className={kit.rowText}>
          <span className={kit.ttl} dir="auto">{link.name || lang('ParvaneCloudLinkHeading')}</span>
          <span className={kit.sub} dir="auto">
            {[
              link.kind && lang(link.kind === 'folder' ? 'ParvaneCloudFolder' : 'ParvaneCloudLinkKindFile'),
              link.createdAt > 0 && lang('ParvaneCloudLinkCreated', { date: dateText(link.createdAt) }),
              term,
              formatFileSize(lang, link.bytes),
            ].filter(Boolean).join(' · ')}
          </span>
        </span>
      </div>
    );
  }

  function renderVirtualRow(view: CloudVirtualFolder, count: number) {
    const hint = view === 'shared'
      ? (count ? lang('ParvaneCloudSharedCount', { count }) : lang('ParvaneCloudSharedNone'))
      : view === 'links'
        ? (count ? lang('ParvaneCloudLinksCount', { count }) : lang('ParvaneCloudLinksNone'))
        : (count ? lang('ParvaneCloudTrashCount', { count }) : lang('ParvaneCloudEmptyTrash'));
    return (
      <div
        className={buildClassName(kit.row, styles.item)}
        role="listitem"
        tabIndex={0}
        data-virtual={view}
        data-count={count}
        onClick={() => goTo({ view })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') goTo({ view });
        }}
      >
        <span className={kit.ava} style="--c: var(--pv-fg)">
          <PvIcon name={view === 'shared' ? 'users' : view === 'links' ? 'link' : 'trash'} isSmall />
        </span>
        <span className={kit.rowText}>
          <span className={kit.ttl} dir="auto">{virtualName(view)}</span>
          <span className={kit.sub} dir="auto">{hint}</span>
        </span>
      </div>
    );
  }

  function renderCrumb(key: string, title: string, onClick: NoneToVoidFunction, isFirst?: boolean) {
    return (
      <span key={key} className={styles.pathStep}>
        {!isFirst && <i className={styles.pathSlash} aria-hidden="true">/</i>}
        <button type="button" className={styles.pathLink} onClick={onClick}>{title}</button>
      </span>
    );
  }

  return (
    <div
      id="ParvaneCloud"
      className={styles.root}
      data-sync-status={status}
      data-loaded={isLoaded ? '1' : '0'}
      data-place={isVirtual ? place.view : 'drive'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={buildClassName(kit.island, styles.page)}>
        <header className={buildClassName(kit.hdr, kit.hdrTabs)}>
          {!isMobile && <h1 className={buildClassName(kit.hdrTitle, kit.hideM)}>{lang('ParvaneSectionKnowledge')}</h1>}
          <KnowledgeTabs />
          <button
            type="button"
            className={buildClassName(kit.ib, kit.onlyM)}
            aria-label={lang('Search')}
            data-palette-open
            onClick={openPalette}
          >
            <PvIcon name="search" />
          </button>
          <span className={buildClassName(kit.grow, kit.hideM)} />
          {canAdd && isPersonalRoot && (
            <button
              type="button"
              className={buildClassName(kit.pill, kit.hideM)}
              aria-label={lang('ParvaneCloudNewShared')}
              onClick={handleNewShared}
            >
              <PvIcon name="users" isSmall />
              {lang('ParvaneCloudSharedFolder')}
            </button>
          )}
          {canAdd && (
            <button
              type="button"
              className={buildClassName(kit.pill, kit.hideM)}
              aria-label={lang('ParvaneCloudNewFolder')}
              onClick={handleNewFolder}
            >
              <PvIcon name="folder" isSmall />
              {lang('ParvaneCloudFolder')}
            </button>
          )}
          {canAdd && (
            <button
              type="button"
              className={buildClassName(kit.pill, kit.pillAcc, kit.hideM)}
              onClick={handlePickFiles}
            >
              <PvIcon name="upload" isSmall />
              {lang('ParvaneCloudUpload')}
            </button>
          )}
        </header>
        {statusKey && (
          <div className={buildClassName(styles.syncNotice, isBlocked && styles.syncNoticeBlocking)} role="status">
            {lang(statusKey)}
          </div>
        )}
        <div className={buildClassName(styles.content, 'custom-scroll')}>
          {!isBlocked && (
            <div className={styles.tools}>
              <SearchForm>
                <label className={kit.search}>
                  <PvIcon name="search" isSmall className={kit.searchIcon} />
                  <input
                    {...SEARCH_FIELD_PROPS}
                    className={kit.searchInput}
                    value={query}
                    placeholder={lang('ParvaneCloudSearch')}
                    aria-label={lang('ParvaneCloudSearch')}
                    onChange={handleQueryChange}
                  />
                </label>
              </SearchForm>
              {!isTrash && !isSharedList && !isLinksList && (
                <DropdownMenu trigger={SortButton} positionX="right">
                  {SORT_KEYS.map((key) => (
                    <MenuItem
                      key={key}
                      icon={prefs.sort.key !== key ? undefined : prefs.sort.isDescending ? 'down' : 'up'}
                      onClick={handleSort(key)}
                    >
                      {sortTitles[key]}
                    </MenuItem>
                  ))}
                </DropdownMenu>
              )}
            </div>
          )}
          {!isBlocked && isSearch && (
            <div className={styles.found} data-found={entries.length}>
              {lang('ParvaneCloudFound', { count: entries.length })}
            </div>
          )}
          {!isBlocked && !isSearch && (
            <nav className={styles.path} aria-label={lang('ParvaneSectionCloud')}>
              {renderCrumb('root', lang('ParvaneSectionCloud'), handleOpenRoot, true)}
              {place.view && renderCrumb(place.view, virtualName(place.view), () => goTo({ view: place.view }))}
              {container && renderCrumb(container.id, containerName(container), () => handleOpenFolder())}
              {path.map((n) => renderCrumb(n.id, n.name, () => handleOpenFolder(n.id)))}
            </nav>
          )}
          {!isBlocked && !isSearch && container && (container.kind === 'owned' ? (
            <button type="button" className={styles.banner} data-share-banner="owned" onClick={handleAccess}>
              <PvIcon name="users" isSmall />
              <span>
                {container.members.length
                  ? lang('KnowledgeFilesSharedBanner', {
                    name: containerName(container),
                    members: container.members.map((m) => nameOf(m.user)).join(', '),
                  })
                  : lang('KnowledgeFilesSharedBannerAlone', { name: containerName(container) })}
              </span>
            </button>
          ) : (
            <div className={styles.banner} data-share-banner="shared">
              <PvIcon name="users" isSmall />
              <span>
                {lang('KnowledgeFilesIncomingBanner', {
                  name: containerName(container),
                  owner: nameOf(container.owner),
                  rights: lang(container.role === 'editor' ? 'KnowledgeFilesCanEdit' : 'KnowledgeFilesViewOnly'),
                })}
              </span>
            </div>
          ))}
          {canAdd && !isSearch && (
            <div className={buildClassName(kit.chips, kit.onlyM, styles.chips)}>
              <button type="button" className={kit.chip} onClick={handleNewFolder}>
                <PvIcon name="folder" isSmall />
                {lang('ParvaneCloudNewFolder')}
              </button>
              <button type="button" className={kit.chip} onClick={handlePickFiles}>
                <PvIcon name="upload" isSmall />
                {lang('KnowledgeFilesUploadFile')}
              </button>
              {hasAccessChip && (
                <button type="button" className={kit.chip} onClick={handleAccess}>
                  <PvIcon name="users" isSmall />
                  {lang('ParvaneCloudShare')}
                </button>
              )}
              {isPersonalRoot && (
                <button type="button" className={kit.chip} onClick={handleNewShared}>
                  <PvIcon name="users" isSmall />
                  {lang('ParvaneCloudNewShared')}
                </button>
              )}
            </div>
          )}
          {isTrash && entries.length > 0 && (
            <div className={styles.trashNote}>
              <span className={buildClassName(kit.muted, kit.small, kit.grow)}>{lang('ParvaneCloudTrashNote')}</span>
              <button type="button" className={buildClassName(kit.btn, kit.btnDanger)} onClick={handleEmptyTrash}>
                {lang('ParvaneCloudEmptyTrashAction')}
              </button>
            </div>
          )}
          {selectedEntries.length > 0 && (
            <div className={styles.selection} role="toolbar">
              <button
                type="button"
                className={kit.ib}
                aria-label={lang('ParvaneCloudClearSelection')}
                onClick={handleClearSelection}
              >
                <PvIcon name="x" isSmall />
              </button>
              <span className={styles.selectionCount}>
                {lang('ParvaneCloudSelected', { count: selectedEntries.length })}
              </span>
              {isTrash ? (
                <>
                  <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleBulkRestore}>
                    {lang('ParvaneCloudRestore')}
                  </button>
                  <button type="button" className={buildClassName(kit.btn, kit.btnDanger)} onClick={handleBulkPurge}>
                    {lang('ParvaneCloudDeleteForever')}
                  </button>
                </>
              ) : (
                <>
                  {selectedEntries.some((e) => e.node.kind === 'file') && (
                    <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleBulkSend}>
                      {lang('ParvaneCloudSendToChat')}
                    </button>
                  )}
                  {selectionContainer && (
                    <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleBulkMove}>
                      {lang('ParvaneCloudMove')}
                    </button>
                  )}
                  {editableSelection.length > 0 && (
                    <button
                      type="button"
                      className={buildClassName(kit.btn, kit.btnDanger)}
                      onClick={handleBulkDelete}
                    >
                      {lang('ParvaneCloudToTrash')}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {!isLoaded && !isBlocked && <Loading />}
          {isLoaded && (
            <div className={styles.list} role="list">
              {isRoot && invites.map(renderInviteRow)}
              <CloudTransfers />
              {listedFolders?.map(renderContainerRow)}
              {isLinksList && links?.map(renderLinkRow)}
              {entries.map((entry) => {
                const daysLeft = isTrash ? trashDaysLeft(entry.node, now) : undefined;
                const stats = entry.node.kind === 'folder'
                  ? statsByContainer.get(entry.container)?.get(entry.node.id) || NO_CHILDREN : undefined;
                return (
                  <CloudItem
                    key={keyOf(entry)}
                    container={entry.container}
                    node={entry.node}
                    hint={isSearch ? pathText(entry) : undefined}
                    trashHint={daysLeft === undefined ? undefined
                      : daysLeft ? lang('ParvaneCloudTrashDaysLeft', { count: daysLeft }, { pluralValue: daysLeft })
                        : lang('ParvaneCloudTrashExpired')}
                    daysLeft={daysLeft}
                    childCount={stats?.count}
                    folderSize={stats?.size}
                    isSelected={selected.includes(keyOf(entry))}
                    isSelecting={selected.length > 0}
                    isTrash={isTrash}
                    isVault={isVault(entry)}
                    isIncoming={getContainer(entry.container, data)?.kind === 'shared'}
                    onOpen={handleOpen}
                    onToggle={handleToggle}
                    onMenu={handleMenu}
                    onAction={handleAction}
                  />
                );
              })}
              {!hasRows && !hasTransfers && (
                <div className={buildClassName(kit.empty, styles.empty)}>
                  <div>{lang(emptyKey)}</div>
                  {emptyKey === 'ParvaneCloudEmpty' && (
                    <div className={kit.small}>{lang('ParvaneCloudEmptyHint')}</div>
                  )}
                  {emptyKey === 'ParvaneCloudLinksEmpty' && (
                    <div className={kit.small}>{lang('ParvaneCloudLinksEmptyHint')}</div>
                  )}
                </div>
              )}
              {isRoot && renderVirtualRow('shared', sharedFolders.length)}
              {isRoot && renderVirtualRow('links', links?.length || 0)}
              {isRoot && renderVirtualRow('trash', trash.length)}
            </div>
          )}
          {usage && usage.quota > 0 && (
            <footer
              className={buildClassName(styles.usage, usedShare >= USAGE_WARN_SHARE && styles.usageWarn)}
              data-used={usage.used}
              data-quota={usage.quota}
              data-links-bytes={usage.linksBytes}
            >
              <span>
                {lang('ParvaneCloudUsage', {
                  used: formatFileSize(lang, usage.used), total: formatFileSize(lang, usage.quota),
                })}
              </span>
              {sizes.trash > 0 && (
                <span>{` · ${lang('ParvaneCloudUsageTrash', { size: formatFileSize(lang, sizes.trash) })}`}</span>
              )}
              {usage.linksBytes > 0 && (
                <span>{` · ${lang('ParvaneCloudUsageLinks', { size: formatFileSize(lang, usage.linksBytes) })}`}</span>
              )}
              <span>{` · ${lang('KnowledgeFilesEncrypted')}`}</span>
              {usedShare >= USAGE_WARN_SHARE && (
                <span className={styles.usageAlert}>{` ${lang('ParvaneCloudUsageAlmostFull')}`}</span>
              )}
            </footer>
          )}
          {isDragging && <div className={styles.dropZone}>{lang('ParvaneCloudDropHere')}</div>}
        </div>
        {notice && (
          <div className={styles.notice} role="alert" onClick={hideCloudNotice}>
            {notice.code === 'saved' ? lang('ParvaneCloudSavedToCloud')
              : notice.code === 'sent' ? lang('ParvaneCloudSentToChat') : lang(CLOUD_ERROR_KEYS[notice.code])}
          </div>
        )}
      </div>
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
        actions={menuActions()}
        onPick={handleMenuPick}
        onClose={handleCloseMenu}
      />
      <CloudNameDialog
        isOpen={dialog?.type === 'newFolder' || dialog?.type === 'rename'}
        title={lang(dialog?.type === 'rename' ? 'ParvaneCloudRename' : 'ParvaneCloudNewFolder')}
        label={lang(dialog?.type === 'rename' ? 'ParvaneCloudNewName' : 'ParvaneCloudFolderName')}
        confirmLabel={lang(dialog?.type === 'rename' ? 'ParvaneCloudSave' : 'ParvaneCloudCreate')}
        initialName={dialog?.type === 'rename' ? dialog.entry.node.name : undefined}
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
      <CloudPreview
        container={preview?.container}
        node={preview?.node}
        maxBytes={isMobile ? PREVIEW_MAX_BYTES_MOBILE : PREVIEW_MAX_BYTES_DESKTOP}
        siblings={previewSiblings}
        folderText={preview ? pathText(preview) : undefined}
        accessText={preview ? accessText(preview.container) : undefined}
        onNavigate={handleOpen}
        onDownload={handleDownload}
        onSend={handlePreviewSend}
        onMore={handlePreviewMore}
        onClose={handleClosePreview}
      />
    </div>
  );
};

export default memo(Cloud);
