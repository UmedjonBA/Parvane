import { memo } from '../../../lib/teact/teact';

import type { CloudClosedFolder, CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { CloudMenuAnchor } from './CloudMenu';
import type { FolderStats } from './cloudModel';
import type { CloudShownLink } from './cloudStore';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { formatFileSize } from '../../../util/textFormat';
import { LINK_DEFAULT_TTL_DAYS } from '../../../api/parvane/cloudLinks';
import { formatCloudDayLong, formatCloudDayShort } from './cloudFormat';
import {
  answerCloudInvite, dismissCloudClosed, dismissRevokedCloudLink, extendCloudLink, peerLabel, revokeCloudLink,
} from './cloudStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type ContainerProps = {
  info: CloudContainerInfo;
  // Сколько в папке и сколько она занимает, когда менялась (`mtime` — последнее изменение внутри)
  stats?: FolderStats;
  isNarrow?: boolean;
  // Строка стоит среди файлов диска: колонки «Доступ» и «Изменён», как у них
  hasFileColumns?: boolean;
  onOpen: (id: string) => void;
  onLeave: (id: string) => void;
  onMenu: (id: string, anchor?: CloudMenuAnchor) => void;
};

/** «общая · 3 участника» (доска `ZdFilesX`); без участников — «общая, пока без участников». */
export function useSharedLabel() {
  const lang = useLang();
  return (members: number) => (members
    ? lang('KnowledgeFilesSharedMembers', { count: members }, { pluralValue: members })
    : lang('KnowledgeFilesSharedAlone'));
}

// Общая папка строкой списка (доски `PhoneFiles`, `DeskFiles`, `RpFiles`, `ZdFilesX`): своя — «общая · 3 участника»,
// чужая — «от Алии · просмотр»; размер — всё содержимое, дата — последнее изменение внутри. У чужой папки на
// компьютере при наведении — «Открыть» и «Выйти из папки»
const CloudContainerRowBase = ({
  info, stats, isNarrow, hasFileColumns, onOpen, onLeave, onMenu,
}: ContainerProps) => {
  const lang = useLang();
  const sharedLabel = useSharedLabel();
  const isOwned = info.kind === 'owned';
  const name = info.name || lang('ParvaneCloudSharedFolder');
  const roleText = lang(info.role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')
    .toLocaleLowerCase();
  const accessText = isOwned ? sharedLabel(info.members.length)
    : `${lang('KnowledgeFilesFrom', { name: peerLabel(info.owner) })} · ${roleText}`;
  const count = stats?.count || 0;
  const countText = lang('KnowledgeFilesItems', { count }, { pluralValue: count });
  const sizeText = stats?.size ? formatFileSize(lang, stats.size) : '—';
  const dateText = stats?.mtime ? formatCloudDayShort(lang.code, stats.mtime) : '';
  const canHoverActions = !isNarrow && !isOwned;

  const handleOpen = useLastCallback(() => onOpen(info.id));

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(info.id);
  });

  const handleOpenButton = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen(info.id);
  });

  const handleLeave = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onLeave(info.id);
  });

  const handleMenu = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    onMenu(info.id, { x: box.left, y: box.bottom });
  });

  const handleContextMenu = useLastCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onMenu(info.id, { x: e.clientX, y: e.clientY });
  });

  return (
    <div
      className={buildClassName(styles.item, canHoverActions && styles.itemHover)}
      role="listitem"
      tabIndex={0}
      data-container-id={info.id}
      data-container-kind={info.kind}
      data-name={info.name}
      data-drop-container={info.role === 'owner' || info.role === 'editor' ? info.id : undefined}
      data-drop-name={name}
      onClick={handleOpen}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      <span className={buildClassName(styles.itemIcon, styles.itemIconShared)}>
        <PvIcon name="folder" />
      </span>
      <span className={buildClassName(styles.itemText, !hasFileColumns && styles.itemTextWide)}>
        <span className={styles.itemTitle} dir="auto">{name}</span>
        {(isNarrow || !hasFileColumns) && (
          <span className={styles.itemSub} dir="auto">
            {isNarrow && isOwned ? `${lang('ParvaneCloudFolder')} · ${accessText}` : accessText}
          </span>
        )}
      </span>
      {!isNarrow && hasFileColumns && (
        <span className={styles.cellAccess} title={accessText} dir="auto">{accessText}</span>
      )}
      {!isNarrow && hasFileColumns && <span className={styles.cellDate}>{dateText}</span>}
      {!isNarrow && <span className={styles.cellSize} title={countText}>{sizeText}</span>}
      {canHoverActions && (
        <span className={styles.rowHoverActions}>
          <button type="button" className={styles.textButton} data-row-open onClick={handleOpenButton}>
            {lang('Open')}
          </button>
          <button
            type="button"
            className={buildClassName(styles.textButton, styles.textButtonDanger)}
            data-row-leave
            onClick={handleLeave}
          >
            {lang('ParvaneCloudLeave')}
          </button>
        </span>
      )}
      <button type="button" className={styles.itemMenu} aria-label={lang('ParvaneCloudActions')} onClick={handleMenu}>
        <PvIcon name="dots" />
      </button>
    </div>
  );
};

type InviteProps = {
  info: CloudContainerInfo;
  // Сведения о папке, если ключ уже пришёл (число файлов и объём)
  stats?: FolderStats;
  isNarrow?: boolean;
};

// Приглашение в чужую папку: телефон (доска `RpFiles`) — карточка с правами от второго лица, «Отклонить / Принять»;
// компьютер (`ZdFilesX`) — полоса «Дамир приглашает в папку «Проект» · просмотр · 240 МБ» с «Принять / Отклонить»
const CloudInviteCardBase = ({ info, stats, isNarrow }: InviteProps) => {
  const lang = useLang();
  const isEditor = info.role === 'editor';
  const title = lang('ParvaneCloudInviteFrom', {
    name: peerLabel(info.owner), folder: info.name || lang('ParvaneCloudSharedFolder'),
  });
  const roleText = lang(isEditor ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader').toLocaleLowerCase();
  const sizeText = stats?.size ? formatFileSize(lang, stats.size) : undefined;
  const countText = stats?.count
    ? lang('ParvaneCloudInviteFiles', { count: stats.count, size: formatFileSize(lang, stats.size) },
      { pluralValue: stats.count })
    : undefined;

  const handleDecline = useLastCallback(() => void answerCloudInvite(info.id, false));
  const handleAccept = useLastCallback(() => void answerCloudInvite(info.id, true));

  const decline = (
    <button type="button" className={kit.btn} onClick={handleDecline}>{lang('ParvaneCloudDecline')}</button>
  );
  const accept = (
    <button type="button" className={buildClassName(kit.btn, isNarrow && kit.btnAcc)} onClick={handleAccept}>
      {lang('ParvaneCloudAccept')}
    </button>
  );

  return (
    <div
      className={buildClassName(styles.invite, !isNarrow && styles.inviteStrip)}
      role="listitem"
      data-container-id={info.id}
      data-container-kind={info.kind}
      data-name={info.name}
    >
      <span className={styles.inviteText}>
        <span className={styles.inviteTitle} dir="auto">
          {isNarrow ? title : [title, roleText, sizeText].filter(Boolean).join(' · ')}
        </span>
        {isNarrow && (
          <span className={styles.inviteNote}>
            {[
              lang(isEditor ? 'ParvaneCloudInviteRightsEditor' : 'ParvaneCloudInviteRightsReader'),
              countText,
              lang('ParvaneCloudInviteNoSpace'),
            ].filter(Boolean).join(' ')}
          </span>
        )}
      </span>
      <span className={styles.inviteButtons}>
        {isNarrow ? decline : accept}
        {isNarrow ? accept : decline}
      </span>
    </div>
  );
};

type ClosedProps = {
  info: CloudClosedFolder;
};

// Чужая папка, к которой владелец закрыл доступ (доски `ZpFilesX`, `ZdFilesX`): «доступ закрыт владельцем» и «Убрать»
const CloudClosedRowBase = ({ info }: ClosedProps) => {
  const lang = useLang();
  const handleDismiss = useLastCallback(() => void dismissCloudClosed(info.id));

  return (
    <div
      className={buildClassName(styles.item, styles.itemPlain, styles.itemUnavailable)}
      role="listitem"
      aria-disabled
      data-closed-folder={info.id}
    >
      <span className={buildClassName(styles.itemIcon, styles.itemIconMuted)}>
        <PvIcon name="folder" />
      </span>
      <span className={buildClassName(styles.itemText, styles.itemTextWide)}>
        <span className={styles.itemTitle} dir="auto">{info.name || lang('ParvaneCloudSharedFolder')}</span>
        <span className={buildClassName(styles.itemSub, styles.itemBad)}>{lang('ParvaneCloudClosedByOwner')}</span>
      </span>
      <button type="button" className={styles.textButton} data-closed-dismiss onClick={handleDismiss}>
        {lang('ParvaneCloudDismiss')}
      </button>
    </div>
  );
};

type LinkProps = {
  link: CloudShownLink;
  isNarrow?: boolean;
  onOpen: (id: string) => void;
  // Источник отозванной ссылки ещё есть: «Создать новую» — окно ссылки на тот же источник
  canRecreate?: boolean;
  onRecreate: (link: CloudShownLink) => void;
};

// Строка «Моих ссылок» (доски `RdFiles`, `RpFiles`): точка состояния, название, «до 22 ноября · открытий: 0»
// («истекла 10 ноября», «отозвана 2 ноября»), размер; на компьютере — действия по состоянию
const CloudLinkRowBase = ({
  link, isNarrow, canRecreate, onOpen, onRecreate,
}: LinkProps) => {
  const lang = useLang();
  const day = (seconds: number) => formatCloudDayLong(lang.code, seconds * 1000);
  const isActive = link.state === 'active';
  const term = link.state === 'preparing' ? lang('ParvaneCloudLinkUnfinished')
    : link.state === 'revoked' ? lang('ParvaneCloudLinkStateRevoked', { date: day(link.revokedAt || 0) })
      : link.state === 'expired' ? lang('ParvaneCloudLinkStateExpiredOn', { date: day(link.expiresAt) })
        : link.expiresAt ? lang('ParvaneCloudLinkStateUntil', { date: day(link.expiresAt) })
          : lang('ParvaneCloudLinkStateForever');
  const facts = [
    term,
    isActive && lang('ParvaneCloudLinkOpens', { count: link.opens }),
  ].filter(Boolean).join(' · ');

  // Отозванная ссылка не открывается: нажатие — «Создать новую» на тот же источник
  const handleOpen = useLastCallback(() => {
    if (link.state !== 'revoked') onOpen(link.id);
    else if (canRecreate) onRecreate(link);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) handleOpen();
  });

  const handleCopy = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (link.url) copyTextToClipboard(link.url);
  });

  // Действующую ссылку отзывают в её окне (с подтверждением), недействующую убирают сразу
  const handleRevoke = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isActive) onOpen(link.id);
    else if (link.state === 'revoked') dismissRevokedCloudLink(link.id);
    else void revokeCloudLink(link.id);
  });

  const handleExtend = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void extendCloudLink(link.id, LINK_DEFAULT_TTL_DAYS);
  });

  const handleRecreate = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRecreate(link);
  });

  return (
    <div
      className={styles.item}
      role="listitem"
      tabIndex={0}
      data-link-row={link.id}
      data-link-state={link.state}
      data-name={link.name}
      data-bytes={link.bytes}
      data-opens={link.opens}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      <span className={buildClassName(styles.dot, isActive && styles.dotGood)} />
      <span className={buildClassName(styles.itemText, styles.itemTextWide)}>
        <span className={styles.itemTitle} dir="auto">{link.name || lang('ParvaneCloudLinkHeading')}</span>
        <span className={styles.itemSub} dir="auto">{facts}</span>
      </span>
      <span className={styles.cellSize}>{formatFileSize(lang, link.bytes)}</span>
      {!isNarrow && (
        <span className={styles.cellActions}>
          {isActive && link.url && (
            <button type="button" className={styles.textButton} data-row-copy onClick={handleCopy}>
              {lang('ParvaneCloudLinkCopy')}
            </button>
          )}
          {link.state === 'expired' && (
            <button type="button" className={styles.textButton} data-row-extend onClick={handleExtend}>
              {lang('ParvaneCloudLinkExtend')}
            </button>
          )}
          {link.state === 'revoked' && canRecreate && (
            <button type="button" className={styles.textButton} data-row-recreate onClick={handleRecreate}>
              {lang('ParvaneCloudLinkRecreate')}
            </button>
          )}
          <button
            type="button"
            className={buildClassName(styles.textButton, isActive && styles.textButtonDanger)}
            data-row-revoke
            onClick={handleRevoke}
          >
            {lang(isActive ? 'ParvaneCloudLinkRevoke' : 'ParvaneCloudDismiss')}
          </button>
        </span>
      )}
    </div>
  );
};

export const CloudContainerRow = memo(CloudContainerRowBase);
export const CloudInviteCard = memo(CloudInviteCardBase);
export const CloudClosedRow = memo(CloudClosedRowBase);
export const CloudLinkRow = memo(CloudLinkRowBase);
