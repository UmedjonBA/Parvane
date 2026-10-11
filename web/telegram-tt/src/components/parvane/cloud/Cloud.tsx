import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { GlobalState } from '../../../global/types';
import type { CloudMovePlace } from './CloudDialogs';
import type { CloudItemAction } from './CloudItem';
import type { CloudNode, CloudSortKey } from './cloudModel';
import type { CloudPlace, CloudVirtualFolder } from './cloudStore';

import { MAX_BUFFER_SIZE } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import {
  childrenOf, pathOf, searchNodes, sizeOf, sortNodes, trashDaysLeft, usageOf,
} from './cloudModel';
import {
  answerCloudInvite, canEditContainer, createCloudFolder, downloadCloudNode, emptyCloudTrash, getActiveContainerId,
  getCloudData, getCloudNotice, getCloudPlace, getCloudPrefs, getCloudStatus, getCloudTransfers, getCloudUsage,
  getContainer, getIsCloudLoaded, getNodes, getTrash, hideCloudNotice, leaveCloudFolder, loadCloud, moveCloudNodes,
  moveCloudNodesAcross, purgeCloudNodes, refreshCloud, renameCloudNode, restoreCloudNodes, setCloudActive,
  setCloudPlace, setCloudPrefs, shareCloudFolder, trashCloudNodes, uploadCloudFiles,
} from './cloudStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import DropdownMenu from '../../ui/DropdownMenu';
import Loading from '../../ui/Loading';
import MenuItem from '../../ui/MenuItem';
import { CloudFolderDialog, CloudNameDialog } from './CloudDialogs';
import CloudItem from './CloudItem';
import CloudPreview from './CloudPreview';
import CloudSendDialog from './CloudSendDialog';
import CloudShareDialog from './CloudShareDialog';
import CloudTransfers, { CLOUD_ERROR_KEYS } from './CloudTransfers';

import styles from './Cloud.module.scss';

type OwnProps = {
  isMobile?: boolean;
};

type Entry = { container: string; node: CloudNode };
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
  | { type: 'send'; entries: Entry[] };

const SORT_KEYS: CloudSortKey[] = ['name', 'date', 'size'];
// Просмотр держит файл в памяти: на телефоне предел ниже
const PREVIEW_MAX_BYTES_DESKTOP = 256 * 1024 * 1024;
const PREVIEW_MAX_BYTES_MOBILE = 64 * 1024 * 1024;
const USAGE_WARN_SHARE = 0.9;
const PERCENT = 100;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

function keyOf(entry: Entry) {
  return `${entry.container}/${entry.node.id}`;
}

function nameOf(address: string) {
  return address.split('@')[0];
}

// Parvane (spec 016): раздел «Облако» — личное файловое хранилище одним
// списком: путь сверху, поиск по всем папкам и сортировка в шапке, приглашения
// строкой вверху корня, в конце корня — строки-папки «Доступные мне» и
// «Корзина». Дерево — контейнеры домена `cloud.v1` (cloudStore), содержимое
// файлов сервер не видит.
const Cloud = ({ isMobile }: OwnProps) => {
  const lang = useLang();

  const data = useDerivedState(getCloudData);
  const isLoaded = useDerivedState(getIsCloudLoaded);
  const status = useDerivedState(getCloudStatus);
  const place = useDerivedState(getCloudPlace);
  const prefs = useDerivedState(getCloudPrefs);
  const transfers = useDerivedState(getCloudTransfers);
  const usage = useDerivedState(getCloudUsage);
  const notice = useDerivedState(getCloudNotice);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog>();
  const [preview, setPreview] = useState<Entry>();
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

  const trimmedQuery = query.trim();
  const isSearch = Boolean(trimmedQuery);
  const isVirtual = place.view !== undefined && !place.container;
  const isTrash = !isSearch && isVirtual && place.view === 'trash';
  const isSharedList = !isSearch && isVirtual && place.view === 'shared';
  const isRoot = !isSearch && !place.view && !place.container && !place.folder;
  const containerId = isVirtual ? undefined : getActiveContainerId(place, data);
  const container = getContainer(place.container, data);
  const nodes = getNodes(containerId, data);
  // Загружать и создавать можно в открытой папке; строки-папки корня только показывают
  const canEdit = !isVirtual && canEditContainer(place.container, data);

  // Выделение сбрасывается при смене места и запроса
  useEffect(() => {
    setSelected([]);
  }, [place, trimmedQuery]);

  const allContainers = data?.containers;
  const ownedFolders = useMemo(() => (allContainers || []).filter((c) => c.kind === 'owned'), [allContainers]);
  const sharedFolders = useMemo(() => (allContainers || []).filter((c) => c.kind === 'shared'), [allContainers]);
  const invites = useMemo(() => (allContainers || []).filter((c) => c.kind === 'invite'), [allContainers]);
  const trash = useMemo(() => getTrash(data), [data]);

  const entries: Entry[] = useMemo(() => {
    if (trimmedQuery) {
      // Поиск — по всем папкам: личный диск, свои и принятые совместные; корзина не в счёт
      const owners = new Map<CloudNode, string>();
      (allContainers || []).filter((c) => c.kind !== 'invite').forEach((c) => {
        searchNodes(getNodes(c.id, data), trimmedQuery).forEach((node) => owners.set(node, c.id));
      });
      return sortNodes(Array.from(owners.keys()), prefs.sort).map((node) => ({ container: owners.get(node)!, node }));
    }
    if (isTrash) return trash;
    if (isSharedList || !containerId) return [];
    return sortNodes(childrenOf(nodes, place.folder), prefs.sort).map((node) => ({ container: containerId, node }));
  }, [trimmedQuery, allContainers, data, prefs.sort, isTrash, trash, isSharedList, containerId, nodes, place.folder]);

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
    view === 'shared' ? 'ParvaneCloudTabShared' : 'ParvaneCloudTabTrash',
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
    if (action === 'open') handleOpen(entryContainer, node);
    if (action === 'download') handleDownload(entryContainer, node);
    if (action === 'rename') setDialog({ type: 'rename', entry });
    if (action === 'move') setDialog({ type: 'move', container: entryContainer, nodes: [node] });
    if (action === 'delete') void trashCloudNodes(entryContainer, [node]);
    if (action === 'restore') void restoreCloudNodes(entryContainer, [node]);
    if (action === 'purge') setDialog({ type: 'purge', entries: [entry] });
    if (action === 'send') setDialog({ type: 'send', entries: [entry] });
    if (action === 'share') setDialog({ type: 'shareFolder', entry });
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

  const SortButton = ({ onTrigger, isOpen }: { onTrigger: () => void; isOpen?: boolean }) => (
    <Button
      round
      size="smaller"
      color="translucent"
      className={isOpen ? 'active' : undefined}
      iconName="sort"
      ariaLabel={lang('ParvaneCloudSort')}
      onClick={onTrigger}
    />
  );

  const AddButton = ({ onTrigger, isOpen }: { onTrigger: () => void; isOpen?: boolean }) => (
    <Button
      size="smaller"
      className={buildClassName(styles.addButton, isOpen && 'active')}
      iconName="add"
      onClick={onTrigger}
    >
      {lang('ParvaneCloudUpload')}
    </Button>
  );

  const statusKey = status === 'needs-linking' ? 'ParvaneCloudNeedsLinking'
    : status === 'offline' ? 'ParvaneCloudSyncUnavailable'
      : status === 'no-key' ? 'ParvaneCloudSyncPending' : undefined;
  const isBlocked = status === 'needs-linking' || status === 'loading';
  const sortTitles = {
    name: lang('ParvaneCloudSortName'), date: lang('ParvaneCloudSortDate'), size: lang('ParvaneCloudSortSize'),
  };
  const usedShare = usage?.quota ? usage.used / usage.quota : 0;
  const emptyKey = isSearch ? 'ParvaneCloudNothingFound'
    : isTrash ? 'ParvaneCloudEmptyTrash'
      : isSharedList ? 'ParvaneCloudEmptyShared'
        : isRoot ? 'ParvaneCloudEmpty' : 'ParvaneCloudEmptyFolder';
  const moveContainer = dialog?.type === 'move' ? dialog.container : containerId;
  const moveRootName = !moveContainer || moveContainer === data?.rootId
    ? lang('ParvaneCloudTabDrive') : containerName(getContainer(moveContainer, data));
  const listedFolders = isRoot ? ownedFolders : isSharedList ? sharedFolders : undefined;
  const hasRows = entries.length > 0 || Boolean(listedFolders?.length);

  function renderInviteRow(c: CloudContainerInfo) {
    return (
      <div
        key={c.id}
        className={buildClassName(styles.row, styles.containerRow, styles.inviteRow)}
        role="listitem"
        data-container-id={c.id}
        data-container-kind={c.kind}
        data-name={c.name}
      >
        <div className={buildClassName(styles.itemIcon, styles.itemIconShared)}>
          <Icon name="group" />
        </div>
        <div className={styles.itemText}>
          <div className={styles.inviteTitle} dir="auto">
            {lang('ParvaneCloudInviteFrom', { name: nameOf(c.owner), folder: containerName(c) })}
          </div>
          <div className={styles.itemHint} dir="auto">
            {lang(c.role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')}
          </div>
        </div>
        <div className={styles.inviteButtons}>
          <Button size="tiny" isText color="danger" onClick={() => void answerCloudInvite(c.id, false)}>
            {lang('ParvaneCloudDecline')}
          </Button>
          <Button size="tiny" onClick={() => void answerCloudInvite(c.id, true)}>
            {lang('ParvaneCloudAccept')}
          </Button>
        </div>
      </div>
    );
  }

  function renderContainerRow(c: CloudContainerInfo) {
    const isOwned = c.kind === 'owned';
    return (
      <div
        key={c.id}
        className={buildClassName(styles.item, styles.row, styles.containerRow)}
        role="listitem"
        tabIndex={0}
        data-container-id={c.id}
        data-container-kind={c.kind}
        data-name={c.name}
        onClick={() => handleOpenContainer(c.id)}
      >
        <div className={buildClassName(styles.itemIcon, styles.itemIconShared)}>
          <Icon name="group" />
        </div>
        <div className={styles.itemText}>
          <div className={styles.itemName} dir="auto">{containerName(c)}</div>
          <div className={styles.itemHint} dir="auto">
            {isOwned ? lang('ParvaneCloudSharedFolder') : lang('ParvaneCloudSharedBy', { name: nameOf(c.owner) })}
            {c.role && !isOwned && ` · ${lang(
              c.role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader',
            )}`}
          </div>
        </div>
        {isOwned ? (
          <Button
            round
            size="tiny"
            color="translucent"
            iconName="add-user"
            ariaLabel={lang('ParvaneCloudShare')}
            onClick={(e) => {
              e.stopPropagation();
              setDialog({ type: 'share', container: c.id });
            }}
          />
        ) : (
          <Button
            size="tiny"
            isText
            color="danger"
            onClick={(e) => {
              e.stopPropagation();
              setDialog({ type: 'leave', container: c.id });
            }}
          >
            {lang('ParvaneCloudLeave')}
          </Button>
        )}
      </div>
    );
  }

  function renderVirtualRow(view: CloudVirtualFolder, count: number) {
    const hint = view === 'shared'
      ? (count ? lang('ParvaneCloudSharedCount', { count }) : lang('ParvaneCloudSharedNone'))
      : (count ? lang('ParvaneCloudTrashCount', { count }) : lang('ParvaneCloudEmptyTrash'));
    return (
      <div
        className={buildClassName(styles.item, styles.row, styles.containerRow)}
        role="listitem"
        tabIndex={0}
        data-virtual={view}
        data-count={count}
        onClick={() => goTo({ view })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') goTo({ view });
        }}
      >
        <div className={buildClassName(styles.itemIcon, styles.itemIconVirtual)}>
          <Icon name={view === 'shared' ? 'group' : 'delete'} />
        </div>
        <div className={styles.itemText}>
          <div className={styles.itemName} dir="auto">{virtualName(view)}</div>
          <div className={styles.itemHint} dir="auto">{hint}</div>
        </div>
      </div>
    );
  }

  function renderCrumb(key: string, title: string, onClick: NoneToVoidFunction, isFirst?: boolean) {
    return (
      <span key={key} className={styles.pathStep}>
        {!isFirst && <Icon name="next" className={styles.pathArrow} />}
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
      <header className={styles.header}>
        {!isMobile && <h1 className={styles.title}>{lang('ParvaneSectionCloud')}</h1>}
        {!isBlocked && (
          <label className={styles.search}>
            <Icon name="search" className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              placeholder={lang('ParvaneCloudSearch')}
              aria-label={lang('ParvaneCloudSearch')}
              onChange={handleQueryChange}
            />
          </label>
        )}
        {!isBlocked && (
          <div className={styles.headerButtons}>
            {!isTrash && !isSharedList && (
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
            {isTrash && entries.length > 0 && (
              <Button size="smaller" color="danger" isText onClick={() => setDialog({ type: 'emptyTrash' })}>
                {lang('ParvaneCloudEmptyTrashAction')}
              </Button>
            )}
            {canEdit && (
              <DropdownMenu trigger={AddButton} positionX="right">
                <MenuItem icon="document" onClick={handlePickFiles}>{lang('ParvaneCloudUpload')}</MenuItem>
                <MenuItem icon="folder" onClick={() => setDialog({ type: 'newFolder' })}>
                  {lang('ParvaneCloudNewFolder')}
                </MenuItem>
                {!place.container && !place.folder && (
                  <MenuItem icon="group" onClick={() => setDialog({ type: 'newShared' })}>
                    {lang('ParvaneCloudNewShared')}
                  </MenuItem>
                )}
              </DropdownMenu>
            )}
          </div>
        )}
      </header>
      {statusKey && (
        <div className={buildClassName(styles.syncNotice, isBlocked && styles.syncNoticeBlocking)} role="status">
          {lang(statusKey)}
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
          {container && (
            <Button
              className={styles.pathShare}
              size="tiny"
              isText
              onClick={() => setDialog({ type: 'share', container: container.id })}
            >
              {lang('ParvaneCloudShare')}
            </Button>
          )}
        </nav>
      )}
      {selectedEntries.length > 0 && (
        <div className={styles.selection} role="toolbar">
          <Button
            round
            size="tiny"
            color="translucent"
            iconName="close"
            ariaLabel={lang('ParvaneCloudClearSelection')}
            onClick={handleClearSelection}
          />
          <span className={styles.selectionCount}>
            {lang('ParvaneCloudSelected', { count: selectedEntries.length })}
          </span>
          {isTrash ? (
            <>
              <Button size="tiny" isText onClick={handleBulkRestore}>{lang('ParvaneCloudRestore')}</Button>
              <Button size="tiny" isText color="danger" onClick={handleBulkPurge}>
                {lang('ParvaneCloudDeleteForever')}
              </Button>
            </>
          ) : (
            <>
              {selectedEntries.some((e) => e.node.kind === 'file') && (
                <Button size="tiny" isText onClick={handleBulkSend}>{lang('ParvaneCloudSendToChat')}</Button>
              )}
              {selectionContainer && (
                <Button size="tiny" isText onClick={handleBulkMove}>{lang('ParvaneCloudMove')}</Button>
              )}
              {editableSelection.length > 0 && (
                <Button size="tiny" isText color="danger" onClick={handleBulkDelete}>
                  {lang('ParvaneCloudToTrash')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <div className={buildClassName(styles.content, 'custom-scroll')}>
        {!isLoaded && !isBlocked && <Loading />}
        {isLoaded && (
          <div className={styles.list} role="list">
            {isRoot && invites.map(renderInviteRow)}
            {isTrash && entries.length > 0 && (
              <div className={styles.listNote}>{lang('ParvaneCloudTrashNote')}</div>
            )}
            {listedFolders?.map(renderContainerRow)}
            {entries.map((entry) => {
              const daysLeft = isTrash ? trashDaysLeft(entry.node, now) : undefined;
              const canEditThis = canEditEntry(entry);
              return (
                <CloudItem
                  key={keyOf(entry)}
                  container={entry.container}
                  node={entry.node}
                  hint={daysLeft === undefined ? (isSearch ? pathText(entry) : undefined)
                    : daysLeft ? lang('ParvaneCloudTrashDaysLeft', { count: daysLeft }, { pluralValue: daysLeft })
                      : lang('ParvaneCloudTrashExpired')}
                  daysLeft={daysLeft}
                  folderSize={entry.node.kind === 'folder'
                    ? sizeOf(getNodes(entry.container, data), entry.node.id) : undefined}
                  isSelected={selected.includes(keyOf(entry))}
                  isTrash={isTrash}
                  canEdit={canEditThis}
                  canShare={canEditThis && entry.container === data?.rootId}
                  onOpen={handleOpen}
                  onToggle={handleToggle}
                  onAction={handleAction}
                />
              );
            })}
            {!hasRows && (
              <div className={buildClassName(styles.empty, isRoot && styles.emptyRoot)}>
                <div className={styles.emptyTitle}>{lang(emptyKey)}</div>
                {emptyKey === 'ParvaneCloudEmpty' && (
                  <div className={styles.emptyHint}>{lang('ParvaneCloudEmptyHint')}</div>
                )}
              </div>
            )}
            {isRoot && renderVirtualRow('shared', sharedFolders.length)}
            {isRoot && renderVirtualRow('trash', trash.length)}
          </div>
        )}
        {isDragging && <div className={styles.dropZone}>{lang('ParvaneCloudDropHere')}</div>}
      </div>
      <CloudTransfers transfers={transfers} />
      {notice && (
        <div className={styles.notice} role="alert" onClick={hideCloudNotice}>
          {notice.code === 'saved' ? lang('ParvaneCloudSavedToCloud')
            : notice.code === 'sent' ? lang('ParvaneCloudSentToChat') : lang(CLOUD_ERROR_KEYS[notice.code])}
        </div>
      )}
      {usage && usage.quota > 0 && (
        <footer
          className={buildClassName(styles.usage, usedShare >= USAGE_WARN_SHARE && styles.usageWarn)}
          data-used={usage.used}
          data-quota={usage.quota}
        >
          <div className={styles.usageBar}>
            <div className={styles.usageFill} style={`width: ${Math.min(PERCENT, usedShare * PERCENT)}%`} />
          </div>
          <span className={styles.usageText}>
            {lang('ParvaneCloudUsage', {
              used: formatFileSize(lang, usage.used), total: formatFileSize(lang, usage.quota),
            })}
          </span>
          {sizes.trash > 0 && (
            <span className={styles.usageTrash}>
              {lang('ParvaneCloudUsageTrash', { size: formatFileSize(lang, sizes.trash) })}
            </span>
          )}
          {usedShare >= USAGE_WARN_SHARE && (
            <span className={styles.usageAlert}>{lang('ParvaneCloudUsageAlmostFull')}</span>
          )}
        </footer>
      )}
      <input
        ref={fileInputRef}
        className={styles.fileInput}
        type="file"
        multiple
        aria-label={lang('ParvaneCloudUpload')}
        onChange={handleFilesPicked}
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
      <CloudSendDialog
        entries={dialog?.type === 'send' ? dialog.entries : undefined}
        onClose={handleCloseDialog}
      />
      <CloudPreview
        container={preview?.container}
        node={preview?.node}
        maxBytes={isMobile ? PREVIEW_MAX_BYTES_MOBILE : PREVIEW_MAX_BYTES_DESKTOP}
        onDownload={handleDownload}
        onClose={handleClosePreview}
      />
    </div>
  );
};

export default memo(Cloud);
