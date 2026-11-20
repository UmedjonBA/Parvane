import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { CloudLinkInfo } from '../../../api/parvane/cloudDrive';
import type { CloudItemAction } from './CloudItem';
import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { formatFileSize } from '../../../util/textFormat';
import { LINK_DEFAULT_TTL_DAYS, LINK_TTL_DAYS } from '../../../api/parvane/cloudLinks';
import { fileTypeLabel } from './cloudModel';
import { createCloudLink, getCloudLinkProgress } from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import { CLOUD_LINK_TTL_KEYS } from './CloudLinkBlock';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type OwnProps = {
  container: string;
  node: CloudNode;
  link?: CloudLinkInfo;
  canEdit?: boolean;
  // Хранилище заметок: не переносится и не удаляется
  isFixed?: boolean;
  onAction: (action: CloudItemAction, container: string, node: CloudNode) => void;
};

const COPIED_HIDE_MS = 2500;

// Панель выбранного файла на компьютере (доска `DeskFiles`): название и сведения, ссылка со сроком, действия
const CloudDetail = ({
  container, node, link, canEdit, isFixed, onAction,
}: OwnProps) => {
  const lang = useLang();
  const progress = useDerivedState(getCloudLinkProgress);
  const [ttl, setTtl] = useState<number>(LINK_DEFAULT_TTL_DAYS);
  const [isCopied, markCopied, unmarkCopied] = useFlag();

  useEffect(() => {
    if (!isCopied) return undefined;
    const timer = setTimeout(unmarkCopied, COPIED_HIDE_MS);
    return () => clearTimeout(timer);
  }, [isCopied, unmarkCopied]);

  const handleTtl = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setTtl(Number(e.currentTarget.dataset.ttl));
  });

  // Ссылки ещё нет — создаётся на выбранный срок и сразу копируется
  const handleCopyLink = useLastCallback(async () => {
    const ready = link?.state === 'active' ? link
      : await createCloudLink({ container, node: node.id, name: node.name }, ttl);
    if (!ready?.url) return;
    copyTextToClipboard(ready.url);
    markCopied();
  });

  const handleAction = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onAction(e.currentTarget.dataset.detailAction as CloudItemAction, container, node);
  });

  const dateText = node.mtime
    ? new Date(node.mtime).toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '')
    : '';
  const facts = [fileTypeLabel(node.name).toLowerCase(), formatFileSize(lang, node.size), dateText].filter(Boolean);
  const isActive = link?.state === 'active';
  const termText = !isActive ? undefined
    : link.expiresAt ? lang('ParvaneCloudLinkStateUntil', {
      date: new Date(link.expiresAt * 1000).toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }),
    }) : lang('ParvaneCloudLinkStateForever');

  function renderButton(action: CloudItemAction, title: string, className?: string) {
    return (
      <button
        type="button"
        className={buildClassName(kit.btn, styles.detailButton, className)}
        data-detail-action={action}
        onClick={handleAction}
      >
        {title}
      </button>
    );
  }

  return (
    <aside className={styles.detail} data-cloud-detail={node.id} aria-label={node.name}>
      <div>
        <div className={styles.detailName} dir="auto">{node.name}</div>
        <div className={styles.detailFacts}>{facts.join(' · ')}</div>
      </div>
      {canEdit && (
        <div className={styles.detailCard}>
          <div className={styles.detailCaption}>{lang('ParvaneCloudLinkShort')}</div>
          {isActive ? (
            <div className={styles.detailNote}>{termText}</div>
          ) : (
            <div className={styles.detailChips} role="group" aria-label={lang('ParvaneCloudLinkTtl')}>
              {LINK_TTL_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className={buildClassName(kit.chip, ttl === days && kit.chipOn)}
                  aria-pressed={ttl === days}
                  data-ttl={days}
                  onClick={handleTtl}
                >
                  {lang(CLOUD_LINK_TTL_KEYS[days])}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={buildClassName(kit.btn, styles.detailButton)}
            disabled={Boolean(progress)}
            data-detail-link
            onClick={handleCopyLink}
          >
            {lang(isCopied ? 'ParvaneCloudLinkCopied' : progress ? 'ParvaneCloudLinkPreparingStart'
              : 'ParvaneCloudLinkCopyLink')}
          </button>
          {isActive && (
            <button type="button" className={kit.plain} data-detail-action="link" onClick={handleAction}>
              <span className={styles.detailNote}>{lang('ParvaneCloudLinkManage')}</span>
            </button>
          )}
        </div>
      )}
      {renderButton('download', lang('ParvaneCloudDownload'), kit.btnAcc)}
      {renderButton('open', lang('ParvaneCloudView'))}
      {renderButton('send', lang('ParvaneCloudSendToChat'))}
      {renderButton('shareCopy', lang('ParvaneCloudShareCopy'))}
      {Boolean(node.versions?.length) && renderButton(
        'versions', lang('ParvaneCloudVersionsCount', { count: node.versions.length + 1 }),
      )}
      {canEdit && renderButton('rename', lang('ParvaneCloudRename'))}
      {canEdit && !isFixed && renderButton('move', lang('ParvaneCloudMove'))}
      <span className={styles.detailSpace} />
      {canEdit && !isFixed && renderButton('delete', lang('ParvaneCloudToTrash'), styles.chipDanger)}
      {canEdit && !isFixed && <div className={styles.detailNote}>{lang('ParvaneCloudTrashKeeps')}</div>}
    </aside>
  );
};

export default memo(CloudDetail);
