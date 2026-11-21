import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudMenuAnchor } from './CloudMenu';
import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { callApi } from '../../../api/gramjs';
import { formatCloudDayShort } from './cloudFormat';
import { kindOfFile } from './cloudModel';
import { getCloudUnsent } from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import styles from './Cloud.module.scss';

export type CloudItemAction = 'open' | 'download' | 'rename' | 'move' | 'delete' | 'restore' | 'purge' | 'send'
  | 'share' | 'select' | 'link' | 'copy' | 'note' | 'versions' | 'shareCopy';

type OwnProps = {
  container: string;
  node: CloudNode;
  // У кого доступ: «только я», «ссылка, 7 дн.», имя общей папки
  accessText?: string;
  // Поиск: путь до папки вместо доступа (у найденного в корзине — «Корзина · удалится через N дней»)
  hint?: string;
  // Корзина: подпись со сроком и сколько дней осталось до стирания
  trashHint?: string;
  daysLeft?: number;
  // Папка: сколько в ней объектов и сколько они занимают
  childCount?: number;
  folderSize?: number;
  // Папка: последнее изменение внутри (колонка «Изменён»)
  folderMtime?: number;
  // Можно править: клавиши F2 и Del на строке
  canEdit?: boolean;
  isSelected?: boolean;
  // Хотя бы одна строка выделена: флажки видны и без наведения
  isSelecting?: boolean;
  // Компьютер: строка, чьи сведения показаны в панели справа
  isCurrent?: boolean;
  isTrash?: boolean;
  // Телефон: сведения второй строкой, а не колонками
  isNarrow?: boolean;
  // Хранилище заметок «Знания»
  isVault?: boolean;
  // Чужая совместная папка
  isIncoming?: boolean;
  // Компьютер: строку можно перетащить на папку (события ловит корень раздела, `useCloudDrag`)
  isDraggable?: boolean;
  // Папка принимает перетащенные строки
  isDropTarget?: boolean;
  onOpen: (container: string, node: CloudNode, isForced?: boolean) => void;
  // `isRange` — Shift+щелчок: выделить от последней отмеченной строки до этой
  onToggle: (node: CloudNode, isRange?: boolean) => void;
  onMenu: (container: string, node: CloudNode, anchor?: CloudMenuAnchor) => void;
  onAction: (action: CloudItemAction, container: string, node: CloudNode) => void;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Строка файла либо папки (доски `PhoneFiles`, `DeskFiles`, `RdFiles`): на компьютере — строка таблицы
// «Имя / Доступ / Изменён / Размер», на телефоне — название, строка сведений и размер. Нажатие открывает папку;
// файл на компьютере сперва выбирается (панель справа), открывается двойным нажатием либо Enter
const CloudItem = ({
  container, node, accessText, hint, trashHint, daysLeft, childCount, folderSize, folderMtime, canEdit, isSelected,
  isSelecting, isCurrent, isTrash, isNarrow, isVault, isIncoming, isDraggable, isDropTarget, onOpen, onToggle, onMenu,
  onAction,
}: OwnProps) => {
  const lang = useLang();
  const rowRef = useRef<HTMLDivElement>();
  const [thumbUrl, setThumbUrl] = useState<string>();
  const isFolder = node.kind === 'folder';
  const fileKind = isFolder ? undefined : kindOfFile(node.mime, node.name);
  const canDropHere = isFolder && isDropTarget;
  const thumbId = node.thumb?.fileId;
  // Правка узла не ушла из-за связи (доска `PhStates`)
  const isUnsent = useDerivedState(getCloudUnsent).has(node.id);

  // Миниатюра картинки вместо значка: читается, когда строка показалась на экране (адрес хранит провайдер)
  useEffect(() => {
    setThumbUrl(undefined);
    if (!thumbId) return undefined;
    let isActual = true;
    const load = () => {
      // Ключи блоба и миниатюры — из строки: провайдер не ищет узел в дереве
      void callParvane('parvaneCloudThumb', {
        container, node: node.id, blob: node.blob, thumb: node.thumb,
      }).then((url) => {
        if (isActual && typeof url === 'string') setThumbUrl(url);
      }).catch(() => undefined);
    };
    const row = rowRef.current;
    if (!row || typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        isActual = false;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(row);
    return () => {
      isActual = false;
      observer.disconnect();
    };
    // Ключи блоба и миниатюры меняются только вместе с идентификатором миниатюры
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [container, node.id, thumbId]);

  // Компьютер: Ctrl+щелчок отмечает строку, Shift+щелчок — диапазон (выделение как в файловом менеджере)
  const handleOpen = useLastCallback((e: React.MouseEvent) => {
    if (!isNarrow && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      onToggle(node, e.shiftKey);
      return;
    }
    if (isTrash) onMenu(container, node);
    else onOpen(container, node);
  });

  const handleForcedOpen = useLastCallback(() => {
    if (!isTrash) onOpen(container, node, true);
  });

  const handleToggle = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(node);
  });

  const handleMenu = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    onMenu(container, node, { x: box.left, y: box.bottom });
  });

  const handleContextMenu = useLastCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onMenu(container, node, { x: e.clientX, y: e.clientY });
  });

  const handleRestore = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAction('restore', container, node);
  });

  const handlePurge = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAction('purge', container, node);
  });

  const handleLinkClick = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAction('link', container, node);
  });

  const handleDownloadClick = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAction('download', container, node);
  });

  // Клавиши выбранной строки (доски `XdFiles`, `ZdFilesX`): Enter и пробел — открыть, Ctrl+S — скачать,
  // F2 — переименовать, Del — в корзину
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || isTrash) return;
    const isMod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' || (e.key === ' ' && !isFolder)) {
      e.preventDefault();
      handleForcedOpen();
    } else if (isMod && e.key.toLowerCase() === 's' && !isFolder) {
      e.preventDefault();
      onAction('download', container, node);
    } else if (e.key === 'F2' && canEdit) {
      e.preventDefault();
      onAction('rename', container, node);
    } else if (e.key === 'Delete' && canEdit && !isVault) {
      e.preventDefault();
      onAction('delete', container, node);
    }
  });

  const mtime = isFolder ? folderMtime || node.mtime : node.mtime;
  const dateText = mtime ? formatCloudDayShort(lang.code, mtime) : '';
  // Размер папки — всё вложенное, только колонкой компьютера (доска `ZdFilesX`); на телефоне у папки размера нет
  const sizeText = !isFolder ? formatFileSize(lang, node.size)
    : folderSize && !isNarrow ? formatFileSize(lang, folderSize) : '';
  const place = hint || (isVault ? lang('KnowledgeFilesVault') : accessText);
  // Телефон: вторая строка — «14 ноя · только я», у папки — «Папка · только я», у присланного и найденного —
  // сначала откуда («от Алии · 9 ноя», «Мой диск / Сервер · 13 ноя»). В корзине срок стоит второй строкой и на
  // компьютере (в широком окне она встаёт колонкой); на телефоне к нему приписан размер
  const isPlaceFirst = Boolean(hint) || Boolean(node.from);
  const subParts = isTrash ? [trashHint, isNarrow && sizeText]
    : isFolder ? [lang('ParvaneCloudFolder'), place]
      : isPlaceFirst ? [place, dateText] : [dateText, place];
  const countText = isFolder
    ? lang('KnowledgeFilesItems', { count: childCount || 0 }, { pluralValue: childCount || 0 }) : undefined;

  return (
    <div
      ref={rowRef}
      className={buildClassName(
        styles.item, isCurrent && styles.itemOn, isSelected && styles.itemOn, isSelecting && styles.itemSelecting,
      )}
      role="listitem"
      tabIndex={0}
      aria-current={isCurrent ? 'true' : undefined}
      data-node-id={node.id}
      data-container={container}
      data-days-left={daysLeft}
      data-kind={node.kind}
      data-name={node.name}
      data-drop-container={canDropHere ? container : undefined}
      data-drop-folder={canDropHere ? node.id : undefined}
      draggable={isDraggable || undefined}
      onClick={handleOpen}
      onDoubleClick={handleForcedOpen}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      <span
        className={buildClassName(
          styles.itemIcon,
          isFolder && styles.itemIconFolder,
          isIncoming && isFolder && styles.itemIconShared,
          isVault && styles.itemIconVault,
          // Корзина на компьютере (доска `RdFiles`): серая точка вместо значка
          isTrash && !isNarrow && styles.itemIconDot,
        )}
      >
        {isTrash && !isNarrow ? (
          <span className={styles.itemDot} />
        ) : thumbUrl ? (
          <img className={styles.itemThumb} src={thumbUrl} alt="" draggable={false} data-thumb />
        ) : (
          <PvIcon name={isFolder ? 'folder' : fileKind === 'photo' ? 'image' : 'file'} />
        )}
        <button
          type="button"
          role="checkbox"
          aria-checked={Boolean(isSelected)}
          aria-label={lang('ParvaneCloudSelect')}
          className={buildClassName(styles.itemCheck, isSelected && styles.itemCheckOn)}
          onClick={handleToggle}
        >
          {isSelected && <PvIcon name="check" isSmall className={styles.itemCheckMark} />}
        </button>
      </span>
      <span className={buildClassName(styles.itemText, isTrash && styles.itemTextWide)}>
        <span className={styles.itemTitle} title={node.name} dir="auto">{node.name}</span>
        {(isNarrow || isTrash) && (
          <span className={styles.itemSub} dir="auto">{subParts.filter(Boolean).join(' · ')}</span>
        )}
        {isUnsent && <span className={styles.itemUnsent} data-unsent>{lang('ParvaneUnsentMark')}</span>}
      </span>
      {!isNarrow && !isTrash && <span className={styles.cellAccess} title={place} dir="auto">{place}</span>}
      {!isNarrow && !isTrash && <span className={styles.cellDate}>{dateText}</span>}
      {!(isNarrow && isTrash) && (
        <span
          className={styles.cellSize}
          title={isFolder && folderSize ? `${countText} · ${formatFileSize(lang, folderSize)}` : countText}
        >
          {sizeText || (isNarrow ? '' : '—')}
        </span>
      )}
      {isTrash && (
        <span className={styles.cellActions}>
          <button type="button" className={styles.textButton} onClick={handleRestore}>
            {lang('ParvaneCloudRestore')}
          </button>
          {!isNarrow && (
            <button
              type="button"
              className={buildClassName(styles.textButton, styles.textButtonDanger)}
              data-purge
              onClick={handlePurge}
            >
              {lang('ParvaneCloudDeleteForever')}
            </button>
          )}
        </span>
      )}
      {/* Доска `ZdMisc`: под курсором справа — «Ссылка» и «Скачать» (те же действия, что в меню «⋯») */}
      {!isTrash && !isNarrow && (
        <span className={styles.itemHoverActions} data-row-actions>
          {canEdit && (
            <button type="button" className={styles.textButton} data-row-action="link" onClick={handleLinkClick}>
              {lang('ParvaneCloudLinkShort')}
            </button>
          )}
          {!isFolder && (
            <button
              type="button"
              className={styles.textButton}
              data-row-action="download"
              onClick={handleDownloadClick}
            >
              {lang('ParvaneCloudDownload')}
            </button>
          )}
        </span>
      )}
      {!isTrash && (
        <button
          type="button"
          className={styles.itemMenu}
          aria-label={lang('ParvaneCloudFileActions')}
          onClick={handleMenu}
        >
          <PvIcon name="dots" />
        </button>
      )}
    </div>
  );
};

export default memo(CloudItem);
