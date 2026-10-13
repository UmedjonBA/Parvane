import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { callApi } from '../../../api/gramjs';
import { kindOfFile } from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

export type CloudItemAction = 'open' | 'download' | 'rename' | 'move' | 'delete' | 'restore' | 'purge' | 'send'
  | 'share' | 'select' | 'link';

type OwnProps = {
  container: string;
  node: CloudNode;
  // Подпись после размера и даты: путь (поиск)
  hint?: string;
  // Корзина: подпись со сроком и сколько дней осталось до стирания
  trashHint?: string;
  daysLeft?: number;
  // Папка: сколько в ней объектов и сколько они занимают
  childCount?: number;
  folderSize?: number;
  isSelected?: boolean;
  // Хотя бы одна строка выделена: флажки видны и без наведения
  isSelecting?: boolean;
  isTrash?: boolean;
  // Хранилище заметок «Знания»
  isVault?: boolean;
  // Чужая совместная папка
  isIncoming?: boolean;
  onOpen: (container: string, node: CloudNode) => void;
  onToggle: (node: CloudNode) => void;
  onMenu: (container: string, node: CloudNode) => void;
  onAction: (action: CloudItemAction, container: string, node: CloudNode) => void;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 016): строка файла/папки по прототипу — цветная плитка со значком, название, строка
// сведений, «⋯». Нажатие открывает (в корзине — меню), флажок поверх плитки выделяет
const CloudItem = ({
  container, node, hint, trashHint, daysLeft, childCount, folderSize, isSelected, isSelecting, isTrash, isVault,
  isIncoming, onOpen, onToggle, onMenu, onAction,
}: OwnProps) => {
  const lang = useLang();
  const rowRef = useRef<HTMLDivElement>();
  const [thumbUrl, setThumbUrl] = useState<string>();
  const isFolder = node.kind === 'folder';
  const fileKind = isFolder ? undefined : kindOfFile(node.mime, node.name);
  const thumbId = node.thumb?.fileId;

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

  const handleOpen = useLastCallback(() => {
    if (isTrash) onMenu(container, node);
    else onOpen(container, node);
  });

  const handleToggle = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(node);
  });

  const handleMenu = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onMenu(container, node);
  });

  const handleRestore = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAction('restore', container, node);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) handleOpen();
  });

  const dateText = node.mtime
    ? new Date(node.mtime).toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '')
    : '';
  const facts = isTrash ? [trashHint]
    : isVault ? [lang('KnowledgeFilesVault')]
      : isFolder ? [lang('KnowledgeFilesItems', { count: childCount || 0 }, { pluralValue: childCount || 0 })]
        : [formatFileSize(lang, node.size), dateText];
  const color = isVault ? 'var(--pv-yellow)'
    : isIncoming ? 'var(--pv-purple)' : isFolder ? 'var(--pv-blue)' : 'var(--pv-fg)';

  return (
    <div
      ref={rowRef}
      className={buildClassName(kit.row, styles.item, isSelected && kit.rowSel, isSelecting && styles.itemSelecting)}
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
      <span className={styles.itemIcon}>
        <span className={kit.ava} style={`--c: ${color}`}>
          {thumbUrl ? (
            <img className={styles.itemThumb} src={thumbUrl} alt="" draggable={false} data-thumb />
          ) : (
            <PvIcon name={isFolder ? 'folder' : fileKind === 'photo' ? 'image' : 'note'} isSmall />
          )}
        </span>
        <button
          type="button"
          role="checkbox"
          aria-checked={Boolean(isSelected)}
          aria-label={lang('ParvaneCloudSelect')}
          className={buildClassName(styles.itemCheck, isSelected && styles.itemCheckOn)}
          onClick={handleToggle}
        >
          {isSelected && <PvIcon name="check" isSmall />}
        </button>
      </span>
      <span className={kit.rowText}>
        <span className={kit.ttl} title={node.name} dir="auto">{node.name}</span>
        <span
          className={kit.sub}
          dir="auto"
          title={isFolder && folderSize ? formatFileSize(lang, folderSize) : undefined}
        >
          {facts.filter(Boolean).map((fact, i) => (
            <span key={fact}>{`${i ? ' · ' : ''}${fact}`}</span>
          ))}
          {hint && (
            <>
              {' · '}
              <span>{hint}</span>
            </>
          )}
        </span>
      </span>
      {isTrash && (
        <button type="button" className={buildClassName(kit.btn, kit.btnGhost, kit.hideM)} onClick={handleRestore}>
          {lang('ParvaneCloudRestore')}
        </button>
      )}
      <button type="button" className={kit.ib} aria-label={lang('ParvaneCloudActions')} onClick={handleMenu}>
        <PvIcon name="dots" />
      </button>
    </div>
  );
};

export default memo(CloudItem);
