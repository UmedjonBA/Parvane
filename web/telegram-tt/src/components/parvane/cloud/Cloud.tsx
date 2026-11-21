import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { GlobalState } from '../../../global/types';
import type { CloudItemAction } from './CloudItem';
import type { CloudLinkTarget } from './CloudLinkDialog';
import type { CloudMenuAction, CloudMenuAnchor } from './CloudMenu';
import type { CloudNode, CloudSortKey } from './cloudModel';
import type { CloudMovePlace } from './CloudMoveDialog';
import type { CloudNavCounts, CloudNavPlace } from './CloudNav';
import type { CloudPlace, CloudShownLink, CloudVirtualFolder } from './cloudStore';

import { IS_TOUCH_ENV, MAX_BUFFER_SIZE } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import {
  consumeModuleAddRequest, getIsParvaneScreenShown, getModuleAddRequest, getParvaneSection,
  setParvaneSection,
} from '../../../util/parvaneSection';
import { formatFileSize } from '../../../util/textFormat';
import { LINK_SELECTION_PREFIX } from '../../../api/parvane/cloudLinks';
import { dropPlaceTitle } from './cloudDrop';
import { formatCloudDayLong, formatCloudDayShort } from './cloudFormat';
import {
  childrenOf, containerStats, fileTypeLabel, folderStats, isReceivedNode, listedNodes, navTreeOf, pathOf, searchNodes,
  searchTrash, sortNodes, trashDaysLeft, usageOf,
} from './cloudModel';
import { consumeCloudOpenRequest, getCloudOpenRequest } from './cloudOpenRequest';
import { getPeerName } from './cloudPeople';
import {
  canEditContainer, copyCloudNode, createCloudFolder, createCloudFolderAt, dismissCloudClosed, dismissRevokedCloudLink,
  downloadCloudNode, emptyCloudTrash, getActiveContainerId, getCloudData, getCloudLinks, getCloudNotice, getCloudPlace,
  getCloudPrefs, getCloudRevokedLinks, getCloudStatus, getCloudUsage, getContainer, getHasCloudTransfers,
  getIsCloudLoaded, getNodes, getTrash, hideCloudNotice, isCloudOnDevice, leaveCloudFolder, linkOfSource, loadCloud,
  moveCloudNodes, moveCloudNodesAcross, peerLabel, purgeCloudNodes, refreshCloud, refreshCloudLinks, renameCloudNode,
  restoreCloudNodes, retryCloud, revokeDeadCloudLinks, setCloudActive, setCloudPlace, setCloudPrefs, shareCloudFolder,
  trashCloudNodes, uploadCloudFiles,
} from './cloudStore';
import useCloudDrag from './useCloudDrag';
import useCloudHotkeys from './useCloudHotkeys';
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
import PvSkeleton from '../notes/PvSkeleton';
import SectionHistoryBack from '../SectionHistoryBack';
import CloudDetail from './CloudDetail';
import { CloudNameDialog } from './CloudDialogs';
import CloudDropZone from './CloudDropZone';
import CloudItem from './CloudItem';
import CloudLinkDialog from './CloudLinkDialog';
import CloudMenu from './CloudMenu';
import CloudMoveDialog from './CloudMoveDialog';
import CloudNav from './CloudNav';
import CloudNewSharedDialog from './CloudNewSharedDialog';
import CloudNoteDialog from './CloudNoteDialog';
import CloudPreview from './CloudPreview';
import {
  CloudClosedRow, CloudContainerRow, CloudInviteCard, CloudLinkRow, useSharedLabel,
} from './CloudRows';
import CloudSearchField from './CloudSearchField';
import CloudSendDialog from './CloudSendDialog';
import CloudShareCopyDialog from './CloudShareCopyDialog';
import CloudShareDialog from './CloudShareDialog';
import CloudTransfers, { CLOUD_ERROR_KEYS } from './CloudTransfers';
import CloudUsage, { getIsCloudAlmostFull } from './CloudUsage';
import CloudUsageDialog from './CloudUsageDialog';
import CloudVersionsDialog from './CloudVersionsDialog';

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
type ContainerAction = 'open' | 'access' | 'leave' | 'link';
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
  | { type: 'note'; entry: Entry }
  | { type: 'versions'; entry: Entry }
  | { type: 'shareCopy'; entry: Entry }
  | { type: 'usage' };

const SORT_KEYS: CloudSortKey[] = ['name', 'date', 'size'];
// Просмотр держит файл в памяти: на телефоне предел ниже
const PREVIEW_MAX_BYTES_DESKTOP = 256 * 1024 * 1024;
const PREVIEW_MAX_BYTES_MOBILE = 64 * 1024 * 1024;
// Как в стилях: уже — раскладка телефона
const NARROW_WIDTH = 760;
// Поиск по всем папкам применяется с задержкой после ввода, а не на каждую букву
const SEARCH_DEBOUNCE_MS = 150;
const NO_CHILDREN = { count: 0, size: 0, mtime: 0 };
// Папка хранилища заметок в корне личного диска (названия — как в `notes/notesStore.ts`)
const VAULT_NAMES = ['Знания', 'Knowledge'];
// Заголовки колонок компьютера («Изменён», доска `DeskFiles`) и чипы «Порядок» телефона («Дата», `ZpFilesX`)
const SORT_SHORT_KEYS = {
  name: 'ParvaneCloudName', date: 'ParvaneCloudModified', size: 'ParvaneCloudSize',
} as const;
const SORT_CHIP_KEYS = {
  name: 'ParvaneCloudName', date: 'ParvaneCloudSortChipDate', size: 'ParvaneCloudSize',
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
  const sharedLabel = useSharedLabel();

  const data = useDerivedState(getCloudData);
  const isLoaded = useDerivedState(getIsCloudLoaded);
  const isOffline = useCloudOffline();
  // Без связи показан снимок дерева с устройства (доски `ZpFilesX`, `ZdFilesX`: «показано сохранённое») — список и
  // строки «Передач» видны, хотя движок ещё не поднялся
  const isListReady = isLoaded || isOffline;
  const status = useDerivedState(getCloudStatus);
  const place = useDerivedState(getCloudPlace);
  const prefs = useDerivedState(getCloudPrefs);
  // Сам ход переносов показывает `CloudTransfers`; здесь нужно лишь знать, есть ли они
  const hasTransfers = useDerivedState(getHasCloudTransfers);
  const usage = useDerivedState(getCloudUsage);
  const notice = useDerivedState(getCloudNotice);
  const serverLinks = useDerivedState(getCloudLinks);
  const revokedLinks = useDerivedState(getCloudRevokedLinks);
  // «Мои ссылки»: ссылки сервера и отозванные на этом устройстве («отозвана 2 ноября» до «Убрать»)
  const links = serverLinks;
  const shownLinks: CloudShownLink[] | undefined = useMemo(() => (serverLinks || revokedLinks.length
    ? [...(serverLinks || []), ...revokedLinks] : undefined), [serverLinks, revokedLinks]);

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
  // Ctrl+U — «Загрузить» (доска `ZdNav`)
  useCloudHotkeys(isShown);
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
  // Файлы, присланные копией (CLOUD-3): корень диска, «Доступные мне» → «Файлы»
  const driveId = data?.rootId;
  const received = useMemo(() => getNodes(driveId, data).filter(isReceivedNode), [driveId, data]);
  // Счётчики папок (число детей, размер поддерева) — одним проходом по каждому контейнеру
  const statsByContainer = useMemo(() => new Map(
    (allContainers || []).map((c) => [c.id, folderStats(getNodes(c.id, data))]),
  ), [allContainers, data]);
  // Совместные папки целиком: объекты, объём, последнее изменение (строки папок, доски `ZdFilesX`, `RpFiles`)
  const containerStatsById = useMemo(() => new Map(
    (allContainers || []).filter((c) => c.kind !== 'root').map((c) => [c.id, containerStats(getNodes(c.id, data))]),
  ), [allContainers, data]);

  const entries: Entry[] = useMemo(() => {
    if (trimmedQuery) {
      // Поиск — по всем папкам: личный диск, свои и принятые совместные, и корзина (доска `ZpFilesX`) — её
      // находки после остального
      const owners = new Map<CloudNode, string>();
      const trashed = new Map<CloudNode, string>();
      (allContainers || []).filter((c) => c.kind !== 'invite').forEach((c) => {
        const listed = listedNodes(getNodes(c.id, data));
        searchNodes(listed, trimmedQuery).forEach((node) => owners.set(node, c.id));
        searchTrash(listed, trimmedQuery).forEach((node) => trashed.set(node, c.id));
      });
      return [
        ...sortNodes(Array.from(owners.keys()), prefs.sort).map((node) => ({ container: owners.get(node)!, node })),
        ...sortNodes(Array.from(trashed.keys()), prefs.sort).map((node) => ({ container: trashed.get(node)!, node })),
      ];
    }
    if (isTrash) return trash;
    if (isSharedList) return sortNodes(received, prefs.sort).map((node) => ({ container: driveId!, node }));
    if (!containerId) return [];
    // Служебные файлы Parvane (отметка справки в хранилище заметок) в списке не показываются; присланные копией
    // лежат в корне диска, но показываются в «Доступных мне»
    const isDriveRoot = containerId === driveId && !place.folder;
    const shown = childrenOf(listedNodes(nodes), place.folder).filter((n) => !isDriveRoot || !isReceivedNode(n));
    return sortNodes(shown, prefs.sort).map((node) => ({ container: containerId, node }));
  }, [
    trimmedQuery, allContainers, data, prefs.sort, isTrash, trash, isSharedList, received, driveId, containerId, nodes,
    place.folder,
  ]);

  // Куда можно переносить: личный диск и совместные папки с правом записи
  const movePlaces: CloudMovePlace[] = useMemo(() => (
    (allContainers || [])
      .filter((c) => c.kind !== 'invite' && (c.role === 'owner' || c.role === 'editor'))
      .map((c) => ({
        id: c.id,
        name: c.kind === 'root' ? lang('ParvaneCloudTabDrive') : c.name || lang('ParvaneCloudSharedFolder'),
        isShared: c.kind !== 'root',
        members: c.kind === 'root' ? undefined : c.members.length,
        memberNames: c.kind === 'root' ? undefined
          : [c.owner, ...c.members.map((m) => m.user)].filter((user) => user !== c.owner || c.kind !== 'owned')
            .map(getPeerName).join(', '),
        nodes: getNodes(c.id, data),
      }))
  ), [allContainers, data, lang]);

  // Дерево папок диска в колонке мест (компьютер): раскрыт путь до открытой папки диска
  const driveFolder = !place.view && !place.container ? place.folder : undefined;
  const driveNodes = getNodes(data?.rootId, data);
  const navTree = useMemo(() => (isNarrow ? undefined : navTreeOf(driveNodes, driveFolder)), [
    isNarrow, driveNodes, driveFolder,
  ]);

  const navCounts: CloudNavCounts = useMemo(() => ({
    owned: ownedFolders.length,
    shared: sharedFolders.length + invites.length + received.length,
    links: shownLinks?.length || 0,
    trash: trash.length,
  }), [ownedFolders, sharedFolders, invites, received, shownLinks, trash]);

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

  /** Откуда удалено: папка узла (она может лежать в корзине и сама) либо корень его места. */
  const trashOriginName = (entry: Entry) => {
    const parent = entry.node.parent
      ? getNodes(entry.container, data).find((n) => n.id === entry.node.parent) : undefined;
    if (parent) return parent.name;
    return entry.container === data?.rootId
      ? lang('ParvaneCloudTabDrive') : containerName(getContainer(entry.container, data));
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
  const handleNavFolder = useLastCallback((folder: string) => goTo({ folder }));
  const handleOpenView = useLastCallback(() => goTo(place.view ? { view: place.view } : {}));
  const handleOpenDrive = useLastCallback(() => goTo({}));
  const handleOpenLinks = useLastCallback(() => {
    setDialog(undefined);
    goTo({ view: 'links' });
  });
  const handleUsageTrash = useLastCallback(() => {
    setDialog(undefined);
    goTo({ view: 'trash' });
  });
  // «Освободить»: телефон — корзина, компьютер — «Что занимает место» (доски `RpFiles`, `ZdFilesX`)
  const handleFreeUp = useLastCallback(() => {
    if (isNarrow) goTo({ view: 'trash' });
    else setDialog({ type: 'usage' });
  });
  const handleLeaveContainer = useLastCallback((id: string) => setDialog({ type: 'leave', container: id }));
  const handleDismissClosedHere = useLastCallback(() => {
    if (place.container) void dismissCloudClosed(place.container);
  });

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

  // Файл либо папка из общего поиска: папка открывается, файл — в своей папке выбранным (телефон — просмотр)
  const openRequest = useDerivedState(getCloudOpenRequest);
  const pendingOpenRef = useRef<{ container: string; node: CloudNode }>();
  useLayoutEffect(() => {
    if (!openRequest || !isShown || !isReady) return;
    consumeCloudOpenRequest();
    const node = getNodes(openRequest.container, data).find(({ id }) => id === openRequest.node);
    if (!node) return;
    if (node.kind === 'folder') {
      goTo(placeOf(openRequest.container, node.id));
      return;
    }
    // У узла в корне `parent` — пустая строка: место без папки, иначе список корня пуст
    goTo(placeOf(openRequest.container, node.parent || undefined));
    handleOpen(openRequest.container, node);
    // Смена места сбрасывает выбранный файл эффектом выше — выбор ставится ещё раз после сброса
    pendingOpenRef.current = { container: openRequest.container, node };
    // `placeOf` и `goTo` — функции этого кадра; эффект зависит от запроса и готовности дерева
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [openRequest, isShown, isReady, data]);

  useEffect(() => {
    const pending = pendingOpenRef.current;
    if (!pending) return;
    pendingOpenRef.current = undefined;
    handleOpen(pending.container, pending.node);
  }, [place, trimmedQuery, handleOpen]);

  const handlePreviewNavigate = useLastCallback((entryContainer: string, node: CloudNode) => {
    setPreview({ container: entryContainer, node });
  });

  const handleToggle = useLastCallback((node: CloudNode, isRange?: boolean) => {
    const entry = entries.find((e) => e.node.id === node.id);
    if (!entry) return;
    const key = keyOf(entry);
    const anchor = selected[selected.length - 1];
    const from = anchor ? entries.findIndex((e) => keyOf(e) === anchor) : -1;
    if (isRange && from >= 0) {
      const to = entries.indexOf(entry);
      const range = entries.slice(Math.min(from, to), Math.max(from, to) + 1).map(keyOf);
      setSelected([...selected.filter((k) => !range.includes(k)), ...range]);
      return;
    }
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
    if (action === 'versions') setDialog({ type: 'versions', entry });
    if (action === 'shareCopy') setDialog({ type: 'shareCopy', entry });
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

  const handleOpenLink = useLastCallback((linkId: string) => setDialog({ type: 'link', target: { linkId } }));
  /** Источник ссылки ещё на месте: узел (либо все выбранные) не стёрт и не в корзине; без узла — вся папка. */
  const hasLinkSource = (link: CloudShownLink) => {
    if (!link.source || !getContainer(link.source.container, data)) return false;
    const ids = link.source.node.startsWith(LINK_SELECTION_PREFIX)
      ? link.source.node.slice(LINK_SELECTION_PREFIX.length).split(',') : [link.source.node].filter(Boolean);
    const sourceNodes = getNodes(link.source.container, data);
    return ids.every((id) => sourceNodes.some((n) => n.id === id && !n.trashed));
  };

  // «Создать новую» у отозванной ссылки: окно ссылки на тот же источник (ссылка создаётся при открытии)
  const handleRecreateLink = useLastCallback((link: CloudShownLink) => {
    if (!link.source) return;
    dismissRevokedCloudLink(link.id);
    setDialog({ type: 'link', target: { source: { ...link.source, name: link.name || '' } } });
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
    if (action === 'link') {
      setDialog({
        type: 'link', target: { source: { container: target.id, name: containerName(getContainer(target.id, data)) } },
      });
    }
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

  // Одна ссылка на всё выбранное одного контейнера (доска `XdFiles`): источник `sel:id1,id2`
  const handleBulkLink = useLastCallback(() => {
    if (!selectionContainer) return;
    const chosen = selectedEntries.map((e) => e.node);
    const name = chosen.length > 1
      ? lang('ParvaneCloudMoveWhat', { name: chosen[0].name, count: chosen.length - 1 }, {
        pluralValue: chosen.length - 1,
      })
      : chosen[0].name;
    setDialog({
      type: 'link',
      target: {
        source: {
          container: selectionContainer,
          node: chosen.length > 1 ? `${LINK_SELECTION_PREFIX}${chosen.map((n) => n.id).join(',')}` : chosen[0].id,
          name,
        },
      },
    });
    setSelected([]);
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
      // Папка личного диска (и вложенная, доска `ZdFilesX`) с «сразу открыть доступ» — общая папка
      const parent = place.folder;
      const before = new Set(getNodes(getCloudData()?.rootId).map((n) => n.id));
      void createCloudFolder(name).then(async (isDone) => {
        const rootId = getCloudData()?.rootId;
        if (!isDone || !isShared || !rootId) return;
        const created = getNodes(rootId).find((n) => (
          !before.has(n.id) && n.kind === 'folder' && (n.parent || undefined) === parent
        ));
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

  // «Новая папка» в окне переноса: место не задано — контейнер переносимого
  const handleMoveNewFolder = useLastCallback((
    placeId: string | undefined, parent: string | undefined, name: string,
  ) => createCloudFolderAt(placeId || (dialog?.type === 'move' ? dialog.container : containerId), parent, name));

  // Новая общая папка создана (и приглашения разосланы) — открыть её доступ
  const handleSharedCreated = useLastCallback((id: string) => {
    void refreshCloud().then(() => setDialog({ type: 'share', container: id }));
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
  // Компьютер (доска `ZdFilesX`) — «Этот компьютер ещё не привязан», телефон (`ZpFilesX`) — «Устройство…»
  const statusTitleKey = status !== 'needs-linking' ? 'ParvaneCloudStateNoKey'
    : isNarrow ? 'ParvaneCloudStateNotLinked' : 'ParvaneCloudStateNotLinkedDesktop';
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
  // Чужие папки, к которым владелец закрыл доступ: строки «Нет доступа» в «Доступных мне»; открытая такая папка —
  // «Нет доступа» вместо содержимого (доски `ZpFilesX`, `ZdFilesX`)
  const closedFolders = data?.closed;
  const shownClosed = isSharedList ? closedFolders : undefined;
  const closedHere = place.container ? closedFolders?.find((c) => c.id === place.container) : undefined;
  const deadLinks = (shownLinks || []).filter((l) => l.state !== 'active').length;
  const activeLinks = (shownLinks || []).length - deadLinks;
  const hasRows = entries.length > 0 || Boolean(listedFolders?.length) || Boolean(shownInvites?.length)
    || Boolean(shownClosed?.length) || (isLinksList && Boolean(shownLinks?.length));
  const canAdd = !isBlocked && canEdit;
  // Личный диск (корень и вложенные папки): у новой папки есть «сразу открыть доступ»
  const isPersonalDrive = !place.view && !place.container;
  const vaultId = getNodes(data?.rootId, data).find((n) => (
    n.kind === 'folder' && !n.parent && !n.trashed && VAULT_NAMES.includes(n.name)
  ))?.id;
  // «в «Мой диск / Сервер»» — подзаголовок окна новой папки
  const placePathText = [
    place.view ? virtualName(place.view) : lang('ParvaneCloudTabDrive'),
    ...(container ? [containerName(container)] : []),
    ...path.map((n) => n.name),
  ].join(' / ');
  // Имена соседей: совпавшее — ошибка в поле окна имени
  const nameDialogTaken = dialog?.type === 'rename'
    ? getNodes(dialog.entry.container, data)
      .filter((n) => !n.trashed && (n.parent || undefined) === (dialog.entry.node.parent || undefined)
        && n.id !== dialog.entry.node.id)
      .map((n) => n.name)
    : dialog?.type === 'newFolder' ? childrenOf(nodes, place.folder).map((n) => n.name) : undefined;
  const versionsBytes = useMemo(() => getNodes(data?.rootId, data)
    .reduce((sum, n) => sum + (n.versions || []).reduce((acc, v) => acc + v.size, 0), 0), [data]);
  const isVault = (entry: Entry) => entry.container === data?.rootId && entry.node.kind === 'folder'
    && !entry.node.parent && VAULT_NAMES.includes(entry.node.name);
  // Файлы открытой папки — между ними листает просмотр
  const previewSiblings = entries.filter((entry) => entry.node.kind === 'file');
  const navPlace: CloudNavPlace = place.view || 'drive';
  const hasFileColumns = !isTrash && !isLinksList && !isOwnedList && !isSharedList;
  // Строки тащат мышью на компьютере; на телефоне перенос — выделением и «Переместить»
  const canDragRows = !isNarrow && !IS_TOUCH_ENV && !isTrash;

  const dayText = (seconds: number) => formatCloudDayShort(lang.code, seconds * 1000);

  /** Колонка «Доступ»: ссылка со сроком («ссылка до 22 ноября», доска `ZdFilesX`), участники общей папки либо
   * «только я». */
  const accessText = (entry: Entry) => {
    const link = linkOfSource(links, { container: entry.container, node: entry.node.id });
    if (link?.state === 'active') {
      return link.expiresAt ? lang('ParvaneCloudAccessLinkUntil', {
        date: formatCloudDayLong(lang.code, link.expiresAt * 1000),
      }) : lang('ParvaneCloudAccessLink');
    }
    if (entry.node.from && entry.container === driveId) {
      return lang('KnowledgeFilesFrom', { name: peerLabel(entry.node.from) });
    }
    const c = getContainer(entry.container, data);
    if (!c || c.kind === 'root') return lang('KnowledgeFilesOnlyYou');
    if (c.kind !== 'owned') return lang('KnowledgeFilesFrom', { name: peerLabel(c.owner) });
    return c.members.length ? sharedLabel(c.members.length) : lang('KnowledgeFilesOnlyYou');
  };

  const menuNode = menu?.type === 'node' ? menu.entry.node : undefined;
  const menuTitle = !menu ? undefined
    : menu.type === 'node' ? menu.entry.node.name : containerName(getContainer(menu.id, data));
  // «архив · 1,2 ГБ · 14 ноя · на устройстве нет» (доска `XpFiles`; признак — только в шторке телефона)
  const menuFacts = menuNode && menuNode.kind === 'file' ? [
    fileTypeLabel(menuNode.name).toLowerCase(),
    formatFileSize(lang, menuNode.size),
    menuNode.mtime ? dayText(menuNode.mtime / 1000) : '',
    isNarrow && lang(isCloudOnDevice(menuNode.blob?.fileId) ? 'ParvaneCloudOnDevice' : 'ParvaneCloudNotOnDevice'),
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
      const menuContainer = getContainer(menu.id, data);
      const isOwned = menuContainer?.kind === 'owned';
      // Ссылка на совместную папку целиком — пунктом меню (в окне доступа её больше нет, доска `DkFilesDialogs`)
      const canLink = menuContainer?.role === 'owner' || menuContainer?.role === 'editor';
      return [
        item('open', 'folder', lang('Open')),
        canLink && item('link', 'link', lang(isNarrow ? 'ParvaneCloudLinkMenuPhone' : 'ParvaneCloudLinkMenu')),
        isOwned ? item('access', 'users', lang('ParvaneCloudShare'))
          : item('leave', 'x', lang('ParvaneCloudLeave'), true),
      ].filter((action): action is CloudMenuAction => Boolean(action));
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
    // Подсказки клавиш — меню компьютера (доска `ZdFilesX`), на телефоне у «Скачать» — размер (`XpFiles`)
    const keyHint = (keys: string) => (isNarrow ? undefined : keys);
    const linkItem = canEditThis && item(
      'link', 'link', lang(isNarrow ? 'ParvaneCloudLinkMenuPhone' : 'ParvaneCloudLinkMenu'), undefined, linkHint,
    );
    const shareItem = !isFolder && item(
      'shareCopy', 'users', lang(isNarrow ? 'ParvaneCloudShareCopyPhone' : 'ParvaneCloudShareCopy'),
    );
    const moveItem = canEditThis && !isFixed
      && item('move', 'move', lang(isNarrow ? 'ParvaneCloudMove' : 'ParvaneCloudMoveMenu'));
    const sendItem = !isFolder
      && item('send', 'chat', lang(isNarrow ? 'ParvaneCloudSendToChat' : 'ParvaneCloudSendToChatMenu'));
    // Порядок по доскам: телефон (`XpFiles`) — «Открыть, Скачать, Переименовать, Переместить, Ссылка, Общий доступ,
    // Отправить в чат, … В корзину»; компьютер (`ZdFilesX`) — «Открыть, Скачать, Ссылка…, Доступ собеседникам…,
    // Переименовать, Переместить…, Сделать копию, Отправить в чат…, Вложить в заметку…, История версий, В корзину»
    const head = [
      item('open', isFolder ? 'folder' : 'eye', lang('Open'), undefined, keyHint('Enter')),
      !isFolder && item(
        'download', 'download', lang(isNarrow ? 'ParvaneCloudDownloadToDevice' : 'ParvaneCloudDownload'), undefined,
        isNarrow ? formatFileSize(lang, entry.node.size) : 'Ctrl+S',
      ),
    ];
    const renameItem = canEditThis && item('rename', 'edit', lang('ParvaneCloudRename'), undefined, keyHint('F2'));
    const shareFolderItem = isFolder && canEditThis && entry.container === data?.rootId
      && item('share', 'users', lang('KnowledgeFilesShareOpen'));
    const middle = isNarrow
      ? [renameItem, moveItem, linkItem, shareItem, shareFolderItem, sendItem]
      : [linkItem, shareItem, shareFolderItem, renameItem, moveItem];
    return [
      ...head,
      ...middle,
      canEditThis && !isFixed && item('copy', 'copy', lang('ParvaneCloudMakeCopy')),
      !isNarrow && sendItem,
      !isFolder && canAttachToNote && item('note', 'note', lang('ParvaneCloudAttachToNote')),
      // История версий (CLOUD-3) — после пунктов досок
      !isFolder && item(
        'versions', 'restore', lang('ParvaneCloudVersions'), undefined,
        entry.node.versions?.length ? String(entry.node.versions.length + 1) : undefined,
      ),
      IS_TOUCH_ENV && item('select', 'check', lang('ParvaneCloudSelect')),
      canEditThis && !isFixed && item('delete', 'trash', lang('ParvaneCloudToTrash'), true, keyHint('Del')),
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
            {selectionContainer && renderChip(lang('ParvaneCloudLinkShort'), handleBulkLink)}
            {hasFilesSelected && renderChip(lang('KnowledgeFilesToChat'), handleBulkSend)}
            {editableSelection.length > 0 && renderChip(lang('ParvaneCloudToTrash'), handleBulkDelete, true)}
          </>
        )}
        {renderChip(lang('ParvaneCloudClearSelection'), handleClearSelection)}
      </div>
    );
  }

  // Строка под названием места: сколько там и что с этим делают
  // Компьютер: «3 файла · 2,2 ГБ · хранится 30 дней» (`RdFiles`), «2 действуют · 2 недействующие · 1,4 ГБ»,
  // у папки диска — «6 объектов · занято 3,1 из 20 ГБ» (`ZdFilesX`)
  const linksSummary = [
    lang('ParvaneCloudLinksActive', { count: activeLinks }, { pluralValue: activeLinks }),
    deadLinks > 0 && lang('ParvaneCloudLinksDead', { count: deadLinks }, { pluralValue: deadLinks }),
    usage?.linksBytes ? formatFileSize(lang, usage.linksBytes) : undefined,
  ].filter(Boolean).join(' · ');
  const folderCount = entries.length + (listedFolders?.length || 0);
  const folderNote = !isVirtual && !isSearch && usage && usage.quota > 0 ? [
    lang('KnowledgeFilesItems', { count: folderCount }, { pluralValue: folderCount }),
    lang('ParvaneCloudUsedShort', {
      used: formatFileSize(lang, usage.used), total: formatFileSize(lang, usage.quota),
    }),
  ].join(' · ') : undefined;
  const placeNote = isTrash
    ? lang('ParvaneCloudTrashSummary', { count: trash.length, size: formatFileSize(lang, sizes.trash) }, {
      pluralValue: trash.length,
    })
    : isLinksList ? linksSummary
      : isOwnedList ? lang('ParvaneCloudOwnedNote')
        : isSharedList ? lang('ParvaneCloudSharedNote') : folderNote;
  // «Убрать недействующие»: компьютер — в шапке без числа (`RdFiles`), телефон — под списком с числом (`RpFiles`)
  const placeAction = isTrash && trash.length > 0
    ? {
      title: lang(isNarrow ? 'ParvaneCloudEmptyTrashShort' : 'ParvaneCloudEmptyTrashAction'),
      onClick: handleEmptyTrash,
      isDanger: true,
    }
    : isLinksList && deadLinks > 0
      ? {
        title: isNarrow ? lang('ParvaneCloudLinksRemoveDead', { count: deadLinks })
          : lang('ParvaneCloudLinksRemoveDeadShort'),
        onClick: handleRevokeDead,
        isDanger: false,
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
        {lang(isNarrow ? SORT_CHIP_KEYS[key] : SORT_SHORT_KEYS[key])}
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
          {!isLinksList && !isTrash && <span className={styles.cellMenu} />}
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

  // Папки списка вперемешку со своими общими папками, в общем порядке (доска `PhoneFiles`): папки выше файлов
  const folderRows = useMemo(() => {
    const pseudo = (node: { id: string; name: string }, stats: { size: number; mtime: number }): CloudNode => ({
      id: node.id, kind: 'folder', name: node.name, size: stats.size, mime: '', mtime: stats.mtime,
      trashed: false, trashTop: false, trashedAt: 0,
    });
    const rows = new Map<string, { container?: CloudContainerInfo; entry?: Entry }>();
    const list: CloudNode[] = [];
    (listedFolders || []).forEach((c) => {
      const key = `c:${c.id}`;
      rows.set(key, { container: c });
      list.push(pseudo({ id: key, name: c.name || '' }, containerStatsById.get(c.id) || NO_CHILDREN));
    });
    entries.filter((e) => e.node.kind === 'folder' && !e.node.trashed && !isSearch).forEach((e) => {
      const key = `n:${keyOf(e)}`;
      rows.set(key, { entry: e });
      list.push(pseudo({ id: key, name: e.node.name },
        statsByContainer.get(e.container)?.get(e.node.id) || NO_CHILDREN));
    });
    return sortNodes(list, prefs.sort).map((n) => rows.get(n.id)!);
  }, [listedFolders, entries, isSearch, containerStatsById, statsByContainer, prefs.sort]);
  const restEntries = isSearch ? entries : entries.filter((e) => e.node.kind !== 'folder' || e.node.trashed);

  const trashText = (entry: Entry) => {
    const daysLeft = trashDaysLeft(entry.node, now);
    // Телефон (`PhFilesMore`) — «удалится через 28 дней», колонка компьютера (`RdFiles`) — «через 12 дней · был в
    // «…»»; найденное в корзине (`ZpFilesX`) — «Корзина · удалится через 28 дней»
    const left = !daysLeft ? lang('ParvaneCloudTrashExpired')
      : isNarrow || isSearch ? lang('ParvaneCloudTrashLeft', { count: daysLeft }, { pluralValue: daysLeft })
        : lang('ParvaneCloudTrashIn', { count: daysLeft }, { pluralValue: daysLeft });
    return [
      isSearch && lang('ParvaneCloudTabTrash'),
      left,
      !isNarrow && !isSearch && lang(
        entry.node.kind === 'folder' ? 'ParvaneCloudTrashWasInFolder' : 'ParvaneCloudTrashWasIn',
        { name: trashOriginName(entry) },
      ),
    ].filter(Boolean).join(' · ');
  };

  function renderEntry(entry: Entry) {
    const isTrashed = isTrash || entry.node.trashed;
    const stats = entry.node.kind === 'folder'
      ? statsByContainer.get(entry.container)?.get(entry.node.id) || NO_CHILDREN : undefined;
    return (
      <CloudItem
        key={keyOf(entry)}
        container={entry.container}
        node={entry.node}
        accessText={accessText(entry)}
        hint={isSearch && !isTrashed ? pathText(entry) : undefined}
        trashHint={isTrashed ? trashText(entry) : undefined}
        daysLeft={isTrashed ? trashDaysLeft(entry.node, now) : undefined}
        childCount={stats?.count}
        folderSize={stats?.size}
        folderMtime={stats?.mtime}
        canEdit={canEditEntry(entry)}
        isSelected={selected.includes(keyOf(entry))}
        isSelecting={selected.length > 0}
        isCurrent={current ? keyOf(current) === keyOf(entry) : undefined}
        isTrash={isTrashed}
        isNarrow={isNarrow}
        isVault={isVault(entry)}
        isIncoming={getContainer(entry.container, data)?.kind === 'shared'}
        isDraggable={canDragRows && !isTrashed && canEditEntry(entry) && !isVault(entry)}
        isDropTarget={!isTrashed && canEditEntry(entry)}
        onOpen={handleOpen}
        onToggle={handleToggle}
        onMenu={handleMenu}
        onAction={handleAction}
      />
    );
  }

  function renderContainerRow(c: CloudContainerInfo) {
    return (
      <CloudContainerRow
        key={c.id}
        info={c}
        stats={containerStatsById.get(c.id)}
        isNarrow={isNarrow}
        hasFileColumns={hasFileColumns}
        onOpen={handleOpenContainer}
        onLeave={handleLeaveContainer}
        onMenu={handleContainerMenu}
      />
    );
  }

  // Телефон: корзина и поиск — свой экран со «‹» в шапке (доски `PhFilesMore`, `ZpFilesX`)
  const isPhoneSearch = isNarrow && isSearchShown;
  const isPhoneTrash = isNarrow && isTrash;
  // Полоса «нет связи» и «не привязано»: заголовок и что показано (доски `ZpFilesX`, `ZdFilesX`)
  const offlineText = lang(isNarrow ? 'PvOfflineFiles' : 'ParvaneCloudOfflineDesktop');
  const listHint = isNarrow
    ? (isLinksList && shownLinks?.length ? lang('ParvaneCloudLinksPhoneNote', {
      size: formatFileSize(lang, usage?.linksBytes || 0),
    }) : isSharedList && hasRows ? lang('ParvaneCloudSharedPhoneHint') : undefined)
    : canAdd ? lang('ParvaneCloudDropHint')
      : isTrash ? lang('ParvaneCloudTrashNoteDesktop')
        : isLinksList ? lang('ParvaneCloudLinksNote')
          : isSharedList ? lang('ParvaneCloudSharedHint') : undefined;

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
      {!isPhoneSearch && !isPhoneTrash && (
        <CloudNav
          place={navPlace}
          counts={navCounts}
          driveId={data?.rootId}
          tree={navTree}
          openFolder={driveFolder}
          footer={isNarrow ? undefined : usageBlock}
          onPick={handleNav}
          onPickFolder={handleNavFolder}
        />
      )}
      <header className={styles.head}>
        {selectedEntries.length > 0 ? renderSelection() : (
          <>
            {(isPhoneSearch || isPhoneTrash) && (
              <button
                type="button"
                className={kit.ib}
                aria-label={lang('Back')}
                data-section-search-close={isPhoneSearch || undefined}
                data-cloud-back
                onClick={isPhoneSearch ? handleSearchClose : handleOpenDrive}
              >
                <PvIcon name="left" />
              </button>
            )}
            {isPhoneSearch ? (
              <div className={styles.headText}>
                <h1 className={styles.headTitle}>{lang('ParvaneModuleFiles')}</h1>
                <div className={styles.headSub}>{lang('ParvaneCloudSearchScreen')}</div>
              </div>
            ) : isPhoneTrash ? (
              <h1 className={styles.headTitle}>{lang('ParvaneCloudTabTrash')}</h1>
            ) : isNarrow ? (
              <h1 className={styles.headTitle}>{lang('ParvaneModuleFiles')}</h1>
            ) : (
              <div className={styles.headText}>
                {isSearch ? (
                  <h2 className={styles.headTitle} data-found={entries.length}>
                    {lang('ParvaneCloudFound', { count: entries.length })}
                  </h2>
                ) : renderPath()}
                {placeNote && <div className={styles.headSub} data-place-note>{placeNote}</div>}
              </div>
            )}
            {!isBlocked && !isPhoneSearch && !isPhoneTrash && (
              <PvHeaderSearch
                value={query}
                label={lang('ParvaneCloudSearch')}
                isOpen={!isNarrow}
                onOpen={openSearch}
                onClose={handleSearchClose}
                onChange={setQuery}
              />
            )}
            {isPhoneTrash && placeAction && (
              <button
                type="button"
                className={buildClassName(styles.headLink, styles.chipDanger)}
                data-place-action
                onClick={placeAction.onClick}
              >
                {placeAction.title}
              </button>
            )}
            {!isNarrow && placeAction && (
              <button
                type="button"
                className={buildClassName(kit.btn, styles.headButton, placeAction.isDanger && styles.chipDanger)}
                data-place-action
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
        {isPhoneSearch && !isBlocked && (
          <CloudSearchField
            value={query}
            label={lang('ParvaneCloudSearch')}
            onChange={setQuery}
            onClose={handleSearchClose}
          />
        )}
        {isOffline && (
          <div className={styles.strip} role="status" data-offline-bar>
            <span className={buildClassName(styles.dot, styles.dotBad)} />
            <span className={styles.stripText}>
              <span className={styles.stripTitle}>{lang('ParvaneCloudOfflineTitle')}</span>
              {offlineText}
            </span>
            <button type="button" className={styles.textButton} onClick={retryCloud}>{lang('PvOfflineRetry')}</button>
          </div>
        )}
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
              {lang(isNarrow ? 'ParvaneCloudAlmostFull' : 'ParvaneCloudAlmostFullDesktop', {
                used: formatFileSize(lang, usage.used), total: formatFileSize(lang, usage.quota),
              })}
            </span>
            <button type="button" className={styles.textButton} data-usage-free onClick={handleFreeUp}>
              {lang(isNarrow ? 'ParvaneCloudFreeUp' : 'ParvaneCloudWhatTakesSpace')}
            </button>
          </div>
        )}
        {closedHere && (
          <div className={styles.strip} role="status" data-closed-here={closedHere.id}>
            <span className={buildClassName(styles.dot, styles.dotBad)} />
            <span className={styles.stripText}>
              <span className={styles.stripTitle}>{lang('ParvaneCloudNoAccess')}</span>
              {lang('ParvaneCloudNoAccessText', { name: closedHere.name || lang('ParvaneCloudSharedFolder') })}
            </span>
            <button type="button" className={styles.textButton} data-closed-dismiss onClick={handleDismissClosedHere}>
              {lang('ParvaneCloudDismiss')}
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
        {isPhoneSearch && !isBlocked && (
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
        {isNarrow && !isBlocked && (isTrash || isOwnedList) && (
          <div className={styles.hint}>{isTrash ? lang('ParvaneCloudTrashNote') : placeNote}</div>
        )}
        {isNarrow && isOwnedList && placeAction && (
          <button
            type="button"
            className={buildClassName(styles.strip, styles.stripButton)}
            data-place-action
            onClick={placeAction.onClick}
          >
            {placeAction.title}
          </button>
        )}
        {!isListReady && status !== 'needs-linking' && <PvSkeleton onRetry={retryCloud} />}
        {isListReady && !closedHere && renderColumns()}
        {isListReady && !closedHere && (
          <div className={styles.list} role="list">
            {shownInvites?.map((c) => (
              <CloudInviteCard
                key={c.id}
                info={c}
                stats={containerStatsById.get(c.id)}
                isNarrow={isNarrow}
              />
            ))}
            <CloudTransfers isNarrow={isNarrow} onFreeUp={handleFreeUp} />
            {isSharedList && (Boolean(listedFolders?.length) || Boolean(shownClosed?.length)) && (
              <h3 className={styles.caption}>{lang('ParvaneCloudSharedFolders')}</h3>
            )}
            {folderRows.map((row) => (row.container ? renderContainerRow(row.container) : renderEntry(row.entry!)))}
            {shownClosed?.map((c) => <CloudClosedRow key={c.id} info={c} />)}
            {isSharedList && received.length > 0 && (
              <h3 className={styles.caption} data-shared-files>{lang('ParvaneCloudSharedFiles')}</h3>
            )}
            {isLinksList && shownLinks?.map((link) => (
              <CloudLinkRow
                key={link.id}
                link={link}
                isNarrow={isNarrow}
                canRecreate={link.state === 'revoked' && hasLinkSource(link)}
                onOpen={handleOpenLink}
                onRecreate={handleRecreateLink}
              />
            ))}
            {restEntries.map(renderEntry)}
          </div>
        )}
        {isListReady && !hasRows && !hasTransfers && !closedHere && (
          <PvEmpty
            title={lang(emptyKey)}
            text={emptyKey === 'ParvaneCloudNothingFound' ? undefined : lang(EMPTY_HINT_KEYS[emptyKey])}
            actionText={canAdd && !isSearch ? lang('ParvaneCloudUpload') : undefined}
            data-cloud-empty={emptyKey}
            onAction={handlePickFiles}
          />
        )}
        {isListReady && isSearch && (
          <div className={styles.hint} data-search-note>{lang('ParvaneCloudSearchNote')}</div>
        )}
        {isListReady && hasRows && !isSearch && listHint && (
          <div className={styles.hint} data-list-hint>{listHint}</div>
        )}
        {isNarrow && isLinksList && placeAction && (
          <button
            type="button"
            className={buildClassName(styles.strip, styles.stripButton)}
            data-place-action
            onClick={placeAction.onClick}
          >
            {placeAction.title}
          </button>
        )}
        {isNarrow && !isPhoneSearch && usageBlock}
        {drag.rowDrag && (
          <div className={dragStyles.toast} role="status" data-cloud-drag-hint>
            {!drag.rowDrag.target ? lang('ParvaneCloudDragHint')
              : lang(drag.rowDrag.isNav ? 'ParvaneCloudDragOntoNav' : 'ParvaneCloudDragOnto', {
                name: drag.rowDrag.target,
              })}
          </div>
        )}
        {notice && (
          <div className={styles.notice} role="alert" onClick={hideCloudNotice}>
            {notice.code === 'saved' ? lang('ParvaneCloudSavedToCloud')
              : notice.code === 'sent' ? lang('ParvaneCloudSentToChat')
                : notice.code === 'copySent' ? lang('ParvaneCloudCopySent')
                  : notice.code === 'restored' ? lang('ParvaneCloudVersionRestored')
                    : lang(CLOUD_ERROR_KEYS[notice.code])}
          </div>
        )}
      </div>
      {(drag.uploadCount !== undefined || drag.dropped) && (
        <CloudDropZone
          place={dropPlaceTitle(
            place.view ? virtualName(place.view) : lang('ParvaneCloudTabDrive'),
            container && containerName(container),
            nodes,
            place.folder,
          )}
          count={drag.dropped ? drag.dropped.count : drag.uploadCount!}
          bytes={drag.dropped?.bytes}
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
        label={lang('ParvaneCloudNameLabel')}
        confirmLabel={lang(dialog?.type === 'rename' ? 'ParvaneCloudSave' : 'ParvaneCloudCreate')}
        initialName={dialog?.type === 'rename' ? dialog.entry.node.name : undefined}
        note={dialog?.type === 'newFolder' ? lang('ParvaneCloudNewFolderIn', { place: placePathText }) : undefined}
        takenNames={nameDialogTaken}
        isFolder={dialog?.type !== 'rename' || dialog.entry.node.kind === 'folder'}
        canShare={dialog?.type === 'newFolder' && isPersonalDrive}
        onSubmit={handleSubmitName}
        onClose={handleCloseDialog}
      />
      <CloudMoveDialog
        isOpen={dialog?.type === 'move'}
        isStepwise={isNarrow}
        title={isNarrow ? undefined : moveTitle}
        rootName={moveRootName}
        nodes={dialog?.type === 'move' ? getNodes(dialog.container, data) : nodes}
        movedIds={dialog?.type === 'move' ? dialog.nodes.map((n) => n.id) : []}
        startFolder={moveContainer === containerId ? place.folder : undefined}
        places={movePlaces}
        sourcePlace={dialog?.type === 'move' ? dialog.container : undefined}
        vaultId={vaultId}
        onCreateFolder={handleMoveNewFolder}
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
        isOpen={dialog?.type === 'share'}
        containerId={dialog?.type === 'share' ? dialog.container : undefined}
        isNarrow={isNarrow}
        onChanged={refreshCloud}
        onClose={handleCloseDialog}
      />
      <CloudNewSharedDialog
        isOpen={dialog?.type === 'newShared'}
        isNarrow={isNarrow}
        onCreated={handleSharedCreated}
        onClose={handleCloseDialog}
      />
      <CloudUsageDialog
        isOpen={dialog?.type === 'usage'}
        usage={usage}
        trashBytes={sizes.trash}
        versionsBytes={versionsBytes}
        onOpenTrash={handleUsageTrash}
        onOpenLinks={handleOpenLinks}
        onClose={handleCloseDialog}
      />
      <CloudLinkDialog target={dialog?.type === 'link' ? dialog.target : undefined} onClose={handleCloseDialog} />
      <CloudSendDialog
        entries={dialog?.type === 'send' ? dialog.entries : undefined}
        onClose={handleCloseDialog}
      />
      <CloudNoteDialog entry={dialog?.type === 'note' ? dialog.entry : undefined} onClose={handleCloseDialog} />
      <CloudVersionsDialog
        container={dialog?.type === 'versions' ? dialog.entry.container : undefined}
        nodeId={dialog?.type === 'versions' ? dialog.entry.node.id : undefined}
        onOpen={handlePreviewNavigate}
        onClose={handleCloseDialog}
      />
      <CloudShareCopyDialog
        entry={dialog?.type === 'shareCopy' ? dialog.entry : undefined}
        onClose={handleCloseDialog}
      />
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
