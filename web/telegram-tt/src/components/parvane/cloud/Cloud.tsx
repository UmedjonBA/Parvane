import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { GlobalState } from '../../../global/types';
import type { CloudMovePlace } from './CloudDialogs';
import type { CloudItemAction } from './CloudItem';
import type { CloudNode, CloudSortKey } from './cloudModel';
import type { CloudTab } from './cloudStore';

import { MAX_BUFFER_SIZE } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import {
  childrenOf, pathOf, searchNodes, sizeOf, sortNodes, usageOf,
} from './cloudModel';
import {
  canEditContainer, createCloudFolder, downloadCloudNode, emptyCloudTrash, getActiveContainerId, getCloudData,
  getCloudNotice, getCloudPlace, getCloudPrefs, getCloudStatus, getCloudTransfers, getCloudUsage, getContainer,
  getIsCloudLoaded, getNodes, getTrash, hideCloudNotice, loadCloud, moveCloudNodes, moveCloudNodesAcross,
  purgeCloudNodes, refreshCloud, renameCloudNode, restoreCloudNodes, setCloudActive, setCloudPlace, setCloudPrefs,
  shareCloudFolder, trashCloudNodes, uploadCloudFiles,
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
import TabList from '../../ui/TabList';
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
  | { type: 'send'; entries: Entry[] };

const TABS: CloudTab[] = ['drive', 'shared', 'trash'];
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

// Parvane (spec 016): раздел «Облако» — личное файловое хранилище: папки,
// загрузка и скачивание, корзина, совместные папки. Дерево — контейнеры домена
// `cloud.v1` (cloudStore), содержимое файлов сервер не видит.
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

  const containerId = getActiveContainerId(place, data);
  const container = getContainer(place.container, data);
  const nodes = getNodes(containerId, data);
  const canEdit = place.tab !== 'trash' && canEditContainer(place.container, data);
  const isTrash = place.tab === 'trash';
  const isSharedList = place.tab === 'shared' && !place.container;
  const trimmedQuery = query.trim();

  // Выделение сбрасывается при смене места
  useEffect(() => {
    setSelected([]);
  }, [place]);

  const entries: Entry[] = useMemo(() => {
    if (isTrash) return getTrash(data);
    if (isSharedList || !containerId) return [];
    const list = trimmedQuery ? searchNodes(nodes, trimmedQuery) : childrenOf(nodes, place.folder);
    return sortNodes(list, prefs.sort).map((node) => ({ container: containerId, node }));
  }, [isTrash, isSharedList, containerId, data, nodes, trimmedQuery, place.folder, prefs.sort]);

  const ownedFolders = useMemo(() => (
    (data?.containers || []).filter((c) => c.kind === 'owned')
  ), [data]);
  const sharedFolders = useMemo(() => (
    (data?.containers || []).filter((c) => c.kind === 'shared')
  ), [data]);
  const invites = useMemo(() => (
    (data?.containers || []).filter((c) => c.kind === 'invite')
  ), [data]);

  // Куда можно переносить: личный диск и совместные папки с правом записи
  const movePlaces: CloudMovePlace[] = useMemo(() => (
    (data?.containers || [])
      .filter((c) => c.kind !== 'invite' && (c.role === 'owner' || c.role === 'editor'))
      .map((c) => ({
        id: c.id,
        name: c.kind === 'root' ? lang('ParvaneCloudTabDrive') : c.name || lang('ParvaneCloudSharedFolder'),
        isShared: c.kind !== 'root',
        nodes: getNodes(c.id, data),
      }))
  ), [data, lang]);

  const selectedEntries = entries.filter((e) => selected.includes(keyOf(e)));
  const path = useMemo(() => pathOf(nodes, place.folder), [nodes, place.folder]);
  const sizes = useMemo(() => usageOf(getNodes(data?.rootId, data)), [data]);

  const handleSwitchTab = useLastCallback((index: number) => {
    setQuery('');
    setCloudPlace({ tab: TABS[index] });
  });

  const handleQueryChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  });

  const handleOpenFolder = useLastCallback((folder?: string) => {
    setQuery('');
    setCloudPlace({ tab: place.tab, container: place.container, folder });
  });

  const handleOpenContainer = useLastCallback((id?: string) => {
    setQuery('');
    setCloudPlace({ tab: place.tab, container: id });
  });

  const handleOpen = useLastCallback((entryContainer: string, node: CloudNode) => {
    if (node.kind === 'folder') {
      handleOpenFolder(node.id);
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

  const handleBulkMove = useLastCallback(() => {
    if (!containerId || !selectedEntries.length) return;
    setDialog({ type: 'move', container: containerId, nodes: selectedEntries.map((e) => e.node) });
  });

  const handleBulkDelete = useLastCallback(() => {
    if (!containerId) return;
    void trashCloudNodes(containerId, selectedEntries.map((e) => e.node));
    setSelected([]);
  });

  const handleBulkSend = useLastCallback(() => {
    const files = selectedEntries.filter((e) => e.node.kind === 'file');
    if (files.length) setDialog({ type: 'send', entries: files });
  });

  const runByContainer = (list: Entry[], run: (id: string, nodes: CloudNode[]) => Promise<unknown>) => {
    const grouped = new Map<string, CloudNode[]>();
    list.forEach((e) => grouped.set(e.container, [...(grouped.get(e.container) || []), e.node]));
    grouped.forEach((groupNodes, id) => {
      void run(id, groupNodes);
    });
  };

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

  const handleToggleView = useLastCallback(() => {
    setCloudPrefs({ ...prefs, view: prefs.view === 'list' ? 'grid' : 'list' });
  });

  const handleSort = (key: CloudSortKey) => () => {
    const isSame = prefs.sort.key === key;
    setCloudPrefs({ ...prefs, sort: { key, isDescending: isSame ? !prefs.sort.isDescending : false } });
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
  const tabs = [
    { title: lang('ParvaneCloudTabDrive') },
    { title: lang('ParvaneCloudTabShared'), badgeCount: invites.length || undefined, isBadgeActive: true },
    { title: lang('ParvaneCloudTabTrash') },
  ];
  const rootName = container ? container.name || lang('ParvaneCloudSharedFolder')
    : place.tab === 'shared' ? lang('ParvaneCloudTabShared') : lang('ParvaneCloudTabDrive');
  const sortTitles = {
    name: lang('ParvaneCloudSortName'), date: lang('ParvaneCloudSortDate'), size: lang('ParvaneCloudSortSize'),
  };
  const usedShare = usage?.quota ? usage.used / usage.quota : 0;
  const isEmptyRoot = !place.folder && !place.container && !ownedFolders.length;
  const emptyKey = isTrash ? 'ParvaneCloudEmptyTrash'
    : trimmedQuery ? 'ParvaneCloudNothingFound'
      : isEmptyRoot ? 'ParvaneCloudEmpty' : 'ParvaneCloudEmptyFolder';
  const showOwnedFolders = place.tab === 'drive' && !place.container && !place.folder && !trimmedQuery;
  const hasToolbar = !isSharedList && !isBlocked;

  function renderContainerRow(c: CloudContainerInfo, isInvite?: boolean) {
    return (
      <div
        key={c.id}
        className={buildClassName(styles.item, styles.row, styles.containerRow)}
        role="listitem"
        tabIndex={0}
        data-container-id={c.id}
        data-container-kind={c.kind}
        data-name={c.name}
        onClick={isInvite ? undefined : () => handleOpenContainer(c.id)}
      >
        <div className={buildClassName(styles.itemIcon, styles.itemIconShared)}>
          <Icon name="group" />
        </div>
        <div className={styles.itemText}>
          <div className={styles.itemName} dir="auto">{c.name || lang('ParvaneCloudSharedFolder')}</div>
          <div className={styles.itemHint} dir="auto">
            {c.kind === 'owned'
              ? lang('ParvaneCloudSharedFolder')
              : lang('ParvaneCloudSharedBy', { name: c.owner.split('@')[0] })}
            {c.role && c.kind !== 'owned' && ` · ${lang(
              c.role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader',
            )}`}
          </div>
        </div>
        {isInvite ? (
          <div className={styles.inviteButtons}>
            <Button size="tiny" onClick={() => setDialog({ type: 'share', container: c.id })}>
              {lang('ParvaneCloudOpen')}
            </Button>
          </div>
        ) : (
          <Button
            round
            size="tiny"
            color="translucent"
            iconName={c.kind === 'owned' ? 'add-user' : 'info'}
            ariaLabel={lang('ParvaneCloudShare')}
            onClick={(e) => {
              e.stopPropagation();
              setDialog({ type: 'share', container: c.id });
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      id="ParvaneCloud"
      className={styles.root}
      data-sync-status={status}
      data-loaded={isLoaded ? '1' : '0'}
      data-tab={place.tab}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className={styles.header}>
        {!isMobile && <h1 className={styles.title}>{lang('ParvaneSectionCloud')}</h1>}
        <TabList
          className={styles.tabs}
          tabs={tabs}
          activeTab={TABS.indexOf(place.tab)}
          onSwitchTab={handleSwitchTab}
        />
      </header>
      {statusKey && (
        <div className={buildClassName(styles.syncNotice, isBlocked && styles.syncNoticeBlocking)} role="status">
          {lang(statusKey)}
        </div>
      )}
      {hasToolbar && (
        <div className={styles.toolbar}>
          {!isTrash && (
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
          <div className={styles.toolbarButtons}>
            {isTrash && entries.length > 0 && (
              <Button size="smaller" color="danger" isText onClick={() => setDialog({ type: 'emptyTrash' })}>
                {lang('ParvaneCloudEmptyTrashAction')}
              </Button>
            )}
            {!isTrash && (
              <Button
                round
                size="smaller"
                color="translucent"
                iconName={prefs.view === 'list' ? 'grouped' : 'menu'}
                ariaLabel={lang(prefs.view === 'list' ? 'ParvaneCloudViewGrid' : 'ParvaneCloudViewList')}
                onClick={handleToggleView}
              />
            )}
            {!isTrash && (
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
            {canEdit && (
              <DropdownMenu trigger={AddButton} positionX="right">
                <MenuItem icon="document" onClick={handlePickFiles}>{lang('ParvaneCloudUpload')}</MenuItem>
                <MenuItem icon="folder" onClick={() => setDialog({ type: 'newFolder' })}>
                  {lang('ParvaneCloudNewFolder')}
                </MenuItem>
                {place.tab === 'drive' && !place.container && !place.folder && (
                  <MenuItem icon="group" onClick={() => setDialog({ type: 'newShared' })}>
                    {lang('ParvaneCloudNewShared')}
                  </MenuItem>
                )}
              </DropdownMenu>
            )}
          </div>
        </div>
      )}
      {hasToolbar && !isTrash && (
        <nav className={styles.path} aria-label={rootName}>
          {place.container && (
            <button type="button" className={styles.pathLink} onClick={() => handleOpenContainer()}>
              {lang(place.tab === 'shared' ? 'ParvaneCloudTabShared' : 'ParvaneCloudTabDrive')}
            </button>
          )}
          {place.container && <Icon name="next" className={styles.pathArrow} />}
          <button type="button" className={styles.pathLink} onClick={() => handleOpenFolder()}>{rootName}</button>
          {path.map((n) => (
            <span key={n.id} className={styles.pathStep}>
              <Icon name="next" className={styles.pathArrow} />
              <button type="button" className={styles.pathLink} onClick={() => handleOpenFolder(n.id)}>{n.name}</button>
            </span>
          ))}
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
              {canEdit && <Button size="tiny" isText onClick={handleBulkMove}>{lang('ParvaneCloudMove')}</Button>}
              {canEdit && (
                <Button size="tiny" isText color="danger" onClick={handleBulkDelete}>
                  {lang('ParvaneCloudDelete')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <div className={buildClassName(styles.content, 'custom-scroll')}>
        {!isLoaded && !isBlocked && <Loading />}
        {isLoaded && isSharedList && (
          <div className={styles.list} role="list">
            {invites.length > 0 && <div className={styles.groupTitle}>{lang('ParvaneCloudInvites')}</div>}
            {invites.map((c) => renderContainerRow(c, true))}
            {sharedFolders.map((c) => renderContainerRow(c))}
            {!invites.length && !sharedFolders.length && (
              <div className={styles.empty}>{lang('ParvaneCloudEmptyShared')}</div>
            )}
          </div>
        )}
        {isLoaded && !isSharedList && (
          <div
            className={buildClassName(styles.list, prefs.view === 'grid' && !isTrash && styles.grid)}
            role="list"
            data-view={isTrash ? 'list' : prefs.view}
          >
            {showOwnedFolders && ownedFolders.map((c) => renderContainerRow(c))}
            {entries.map((entry) => (
              <CloudItem
                key={keyOf(entry)}
                container={entry.container}
                node={entry.node}
                view={isTrash ? 'list' : prefs.view}
                hint={trimmedQuery
                  ? [rootName, ...pathOf(nodes, entry.node.parent || undefined).map((n) => n.name)].join(' / ')
                  : undefined}
                folderSize={entry.node.kind === 'folder'
                  ? sizeOf(getNodes(entry.container, data), entry.node.id) : undefined}
                isSelected={selected.includes(keyOf(entry))}
                isTrash={isTrash}
                canEdit={canEdit}
                canShare={canEdit && entry.container === data?.rootId}
                onOpen={handleOpen}
                onToggle={handleToggle}
                onAction={handleAction}
              />
            ))}
            {!entries.length && !(showOwnedFolders && ownedFolders.length) && (
              <div className={styles.empty}>
                <div className={styles.emptyTitle}>{lang(emptyKey)}</div>
                {emptyKey === 'ParvaneCloudEmpty' && (
                  <div className={styles.emptyHint}>{lang('ParvaneCloudEmptyHint')}</div>
                )}
              </div>
            )}
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
        rootName={rootName}
        nodes={dialog?.type === 'move' ? getNodes(dialog.container, data) : nodes}
        movedIds={dialog?.type === 'move' ? dialog.nodes.map((n) => n.id) : []}
        startFolder={place.folder}
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
