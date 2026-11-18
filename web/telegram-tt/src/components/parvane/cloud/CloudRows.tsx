import { memo } from '../../../lib/teact/teact';

import type { CloudLinkInfo } from '../../../api/parvane/cloudDrive';
import type { CloudContainerInfo } from '../../../api/parvane/v2/cloud';
import type { CloudMenuAnchor } from './CloudMenu';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { formatFileSize } from '../../../util/textFormat';
import { answerCloudInvite, peerLabel, revokeCloudLink } from './cloudStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type ContainerProps = {
  info: CloudContainerInfo;
  count: number;
  isNarrow?: boolean;
  // Строка стоит среди файлов диска: колонки «Доступ» и «Изменён», как у них
  hasFileColumns?: boolean;
  onOpen: (id: string) => void;
  onAccess: (id: string) => void;
  onMenu: (id: string, anchor?: CloudMenuAnchor) => void;
};

// Общая папка строкой списка: своя (с участниками) либо чужая («от Алии · просмотр»)
const CloudContainerRowBase = ({
  info, count, isNarrow, hasFileColumns, onOpen, onAccess, onMenu,
}: ContainerProps) => {
  const lang = useLang();
  const isOwned = info.kind === 'owned';
  const name = info.name || lang('ParvaneCloudSharedFolder');
  const roleText = lang(info.role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')
    .toLocaleLowerCase();
  const accessText = isOwned
    ? (info.members.length
      ? lang('KnowledgeFilesSharedWith', { count: info.members.length })
      : lang('KnowledgeFilesSharedAlone'))
    : `${lang('KnowledgeFilesFrom', { name: peerLabel(info.owner) })} · ${roleText}`;
  const countText = lang('KnowledgeFilesItems', { count }, { pluralValue: count });

  const handleOpen = useLastCallback(() => onOpen(info.id));

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(info.id);
  });

  const handleAccess = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAccess(info.id);
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
      className={styles.item}
      role="listitem"
      tabIndex={0}
      data-container-id={info.id}
      data-container-kind={info.kind}
      data-name={info.name}
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
          <span className={styles.itemSub} dir="auto">{isNarrow ? `${countText} · ${accessText}` : accessText}</span>
        )}
      </span>
      {!isNarrow && hasFileColumns && (isOwned ? (
        <button
          type="button"
          className={buildClassName(styles.cellAccess, styles.cellButton)}
          aria-label={lang('ParvaneCloudShare')}
          title={accessText}
          onClick={handleAccess}
        >
          {accessText}
        </button>
      ) : (
        <span className={styles.cellAccess} dir="auto">{accessText}</span>
      ))}
      {!isNarrow && hasFileColumns && <span className={styles.cellDate} />}
      {!isNarrow && <span className={styles.cellSize} title={countText}>—</span>}
      {(isNarrow || !hasFileColumns) && isOwned && (
        <button type="button" className={styles.itemMenu} aria-label={lang('ParvaneCloudShare')} onClick={handleAccess}>
          <PvIcon name="users" isSmall />
        </button>
      )}
      <button type="button" className={styles.itemMenu} aria-label={lang('ParvaneCloudActions')} onClick={handleMenu}>
        <PvIcon name="dots" />
      </button>
    </div>
  );
};

type InviteProps = {
  info: CloudContainerInfo;
};

// Приглашение в чужую папку (доска `RpFiles`): карточка с правами и ответом
const CloudInviteCardBase = ({ info }: InviteProps) => {
  const lang = useLang();
  const isEditor = info.role === 'editor';

  const handleDecline = useLastCallback(() => void answerCloudInvite(info.id, false));
  const handleAccept = useLastCallback(() => void answerCloudInvite(info.id, true));

  return (
    <div
      className={styles.invite}
      role="listitem"
      data-container-id={info.id}
      data-container-kind={info.kind}
      data-name={info.name}
    >
      <span className={styles.inviteText}>
        <span className={styles.inviteTitle} dir="auto">
          {lang('ParvaneCloudInviteFrom', {
            name: peerLabel(info.owner), folder: info.name || lang('ParvaneCloudSharedFolder'),
          })}
        </span>
        <span className={styles.inviteNote}>
          {`${lang(isEditor ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')} — ${
            lang(isEditor ? 'ParvaneCloudRoleEditorHint' : 'ParvaneCloudRoleReaderHint')}. ${
            lang('ParvaneCloudInviteNoSpace')}`}
        </span>
      </span>
      <span className={styles.inviteButtons}>
        <button type="button" className={kit.btn} onClick={handleDecline}>{lang('ParvaneCloudDecline')}</button>
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handleAccept}>
          {lang('ParvaneCloudAccept')}
        </button>
      </span>
    </div>
  );
};

type LinkProps = {
  link: CloudLinkInfo;
  isNarrow?: boolean;
  onOpen: (id: string) => void;
};

// Строка «Моих ссылок» (доски `RdFiles`, `RpFiles`): точка состояния, название, срок, размер; действия справа
const CloudLinkRowBase = ({ link, isNarrow, onOpen }: LinkProps) => {
  const lang = useLang();
  const dateText = (seconds: number) => new Date(seconds * 1000)
    .toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '');
  const isActive = link.state === 'active';
  const term = link.state === 'preparing' ? lang('ParvaneCloudLinkUnfinished')
    : link.state === 'expired' ? lang('ParvaneCloudLinkStateExpired')
      : link.expiresAt ? lang('ParvaneCloudLinkStateUntil', { date: dateText(link.expiresAt) })
        : lang('ParvaneCloudLinkStateForever');
  const facts = [
    link.kind && lang(link.kind === 'folder' ? 'ParvaneCloudFolder' : 'ParvaneCloudLinkKindFile'),
    link.createdAt > 0 && lang('ParvaneCloudLinkCreated', { date: dateText(link.createdAt) }),
    term,
  ].filter(Boolean).join(' · ');

  const handleOpen = useLastCallback(() => onOpen(link.id));

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(link.id);
  });

  const handleCopy = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (link.url) copyTextToClipboard(link.url);
  });

  // Действующую ссылку отзывают в её окне (с подтверждением), недействующую убирают сразу
  const handleRevoke = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isActive) onOpen(link.id);
    else void revokeCloudLink(link.id);
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
          <button
            type="button"
            className={buildClassName(styles.textButton, styles.textButtonDanger)}
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
export const CloudLinkRow = memo(CloudLinkRowBase);
