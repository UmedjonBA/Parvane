import { memo, useRef } from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { getColorFromExtension } from '../../common/helpers/documentInfo';
import { getExtension, kindOfFile } from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import DropdownMenu from '../../ui/DropdownMenu';
import MenuItem from '../../ui/MenuItem';

import styles from './Cloud.module.scss';

export type CloudItemAction = 'open' | 'download' | 'rename' | 'move' | 'delete' | 'restore' | 'purge' | 'send'
  | 'share';

type OwnProps = {
  container: string;
  node: CloudNode;
  // Подпись под именем: путь (поиск), срок (корзина)
  hint?: string;
  // Корзина: сколько дней осталось до стирания
  daysLeft?: number;
  folderSize?: number;
  isSelected?: boolean;
  isTrash?: boolean;
  canEdit?: boolean;
  // Папку личного диска можно сделать совместной
  canShare?: boolean;
  onOpen: (container: string, node: CloudNode) => void;
  onToggle: (node: CloudNode) => void;
  onAction: (action: CloudItemAction, container: string, node: CloudNode) => void;
};

const MENU_CLOSE_GUARD_MS = 350;

function stopEvent(e: React.MouseEvent) {
  e.stopPropagation();
}

// Parvane (spec 016): строка файла/папки. Нажатие открывает, флажок выделяет,
// «⋯» — действия.
const CloudItem = ({
  container, node, hint, daysLeft, folderSize, isSelected, isTrash, canEdit, canShare, onOpen, onToggle, onAction,
}: OwnProps) => {
  const lang = useLang();
  const isFolder = node.kind === 'folder';
  const extension = getExtension(node.name);
  const fileKind = isFolder ? undefined : kindOfFile(node.mime, node.name);

  // Нажатие мимо открытого меню закрывает его (по mousedown); следующий за ним
  // click браузер отдаёт строке — он не должен ни открыть файл, ни снова открыть меню
  const menuClosedAtRef = useRef(0);
  const handleMenuClose = useLastCallback(() => {
    menuClosedAtRef.current = Date.now();
  });
  const isAfterMenuClose = () => Date.now() - menuClosedAtRef.current < MENU_CLOSE_GUARD_MS;

  const handleOpen = useLastCallback(() => {
    if (isTrash || isAfterMenuClose()) return;
    onOpen(container, node);
  });

  const handleToggle = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(node);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleOpen();
  });

  const run = (action: CloudItemAction) => () => onAction(action, container, node);

  const MoreButton = ({ onTrigger, isOpen }: { onTrigger: () => void; isOpen?: boolean }) => (
    <button
      type="button"
      className={buildClassName(styles.itemMore, isOpen && styles.itemMoreOpen)}
      aria-label={lang('ParvaneCloudActions')}
      onClick={(e) => {
        e.stopPropagation();
        if (!isOpen && isAfterMenuClose()) return;
        onTrigger();
      }}
    >
      <Icon name="more" />
    </button>
  );

  const size = isFolder ? folderSize : node.size;
  const sizeText = size ? formatFileSize(lang, size) : isFolder ? lang('ParvaneCloudFolder') : formatFileSize(lang, 0);
  const dateText = node.mtime ? new Date(node.mtime).toLocaleDateString(lang.code) : '';
  const iconName = isFolder ? 'folder' : fileKind === 'photo' ? 'photo' : fileKind === 'video' ? 'video' : 'document';

  return (
    <div
      className={buildClassName(styles.item, styles.row, isSelected && styles.itemSelected)}
      role="listitem"
      tabIndex={0}
      data-node-id={node.id}
      data-container={container}
      data-days-left={daysLeft}
      data-kind={node.kind}
      data-name={node.name}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={Boolean(isSelected)}
        aria-label={lang('ParvaneCloudSelect')}
        className={buildClassName(styles.itemCheck, isSelected && styles.itemCheckOn)}
        onClick={handleToggle}
      >
        {isSelected && <Icon name="check" />}
      </button>
      <div
        className={buildClassName(
          styles.itemIcon,
          isFolder ? styles.itemIconFolder : styles[`itemIcon_${getColorFromExtension(extension)}`],
        )}
      >
        <Icon name={iconName} />
        {!isFolder && extension && <span className={styles.itemExtension}>{extension.slice(0, 4)}</span>}
      </div>
      <div className={styles.itemText}>
        <div className={styles.itemName} title={node.name} dir="auto">{node.name}</div>
        {hint && <div className={styles.itemHint} dir="auto">{hint}</div>}
      </div>
      <div className={styles.itemSize}>{sizeText}</div>
      <div className={styles.itemDate}>{dateText}</div>
      {/* Нажатие мимо открытого меню закрывает его и не должно открывать сам файл */}
      <div className={styles.itemMenu} onClick={stopEvent}>
        <DropdownMenu trigger={MoreButton} positionX="right" onClose={handleMenuClose}>
          {isTrash ? (
            <>
              <MenuItem icon="undo" onClick={run('restore')}>{lang('ParvaneCloudRestore')}</MenuItem>
              <MenuItem icon="delete" destructive onClick={run('purge')}>{lang('ParvaneCloudDeleteForever')}</MenuItem>
            </>
          ) : (
            <>
              <MenuItem icon={isFolder ? 'folder' : 'eye'} onClick={run('open')}>
                {lang(isFolder ? 'ParvaneCloudOpen' : 'ParvaneCloudView')}
              </MenuItem>
              {!isFolder && (
                <MenuItem icon="download" onClick={run('download')}>{lang('ParvaneCloudDownload')}</MenuItem>
              )}
              {canShare && isFolder && (
                <MenuItem icon="add-user" onClick={run('share')}>{lang('ParvaneCloudShare')}</MenuItem>
              )}
              {!isFolder && <MenuItem icon="forward" onClick={run('send')}>{lang('ParvaneCloudSendToChat')}</MenuItem>}
              {canEdit && <MenuItem icon="folder" onClick={run('move')}>{lang('ParvaneCloudMove')}</MenuItem>}
              {canEdit && <MenuItem icon="edit" onClick={run('rename')}>{lang('ParvaneCloudRename')}</MenuItem>}
              {canEdit && (
                <MenuItem icon="delete" destructive onClick={run('delete')}>{lang('ParvaneCloudToTrash')}</MenuItem>
              )}
            </>
          )}
        </DropdownMenu>
      </div>
    </div>
  );
};

export default memo(CloudItem);
