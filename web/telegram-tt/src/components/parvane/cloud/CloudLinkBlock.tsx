import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { CloudLinkInfo } from '../../../api/parvane/cloudDrive';
import type { CloudLinkSource } from './cloudStore';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { formatFileSize } from '../../../util/textFormat';
import { LINK_DEFAULT_TTL_DAYS, LINK_TTL_DAYS } from '../../../api/parvane/cloudLinks';
import {
  cancelCloudLinkCreate, createCloudLink, extendCloudLink, getCloudLinkProgress, revokeCloudLink,
} from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';

import kit from '../notes/PvKit.module.scss';
import seg from '../notes/PvSegment.module.scss';
import styles from './CloudSheets.module.scss';

type OwnProps = {
  // Готовая (либо недоделанная) ссылка; не задана — блок предлагает создать её для `source`
  link?: CloudLinkInfo;
  source?: CloudLinkSource;
  // Блок внутри шторки доступа совместной папки: со своим заголовком
  hasHeading?: boolean;
  onRevoked?: NoneToVoidFunction;
};

export const CLOUD_LINK_TTL_KEYS = {
  1: 'ParvaneCloudLinkTtlDay',
  7: 'ParvaneCloudLinkTtlWeek',
  30: 'ParvaneCloudLinkTtlMonth',
  0: 'ParvaneCloudLinkTtlForever',
} as const;
const COPIED_HIDE_MS = 2500;

// Блок «Ссылка для людей без аккаунта» (spec 022): срок и «Создать ссылку» с ходом подготовки, у готовой —
// адрес, «Скопировать», срок, «Продлить», «Отозвать», «Как увидит получатель». Ссылка — снимок: сервер
// копирует файлы, ключ живёт только в адресе после `#`.
const CloudLinkBlock = ({
  link, source, hasHeading, onRevoked,
}: OwnProps) => {
  const lang = useLang();
  const progress = useDerivedState(getCloudLinkProgress);
  const [ttl, setTtl] = useState<number>(LINK_DEFAULT_TTL_DAYS);
  const [isExtending, openExtend, closeExtend] = useFlag();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [isConfirming, openConfirm, closeConfirm] = useFlag();
  const [isCopied, markCopied, unmarkCopied] = useFlag();

  const linkId = link?.id;
  useEffect(() => {
    closeExtend();
    unmarkCopied();
  }, [linkId, closeExtend, unmarkCopied]);

  useEffect(() => {
    if (!isCopied) return undefined;
    const timer = setTimeout(unmarkCopied, COPIED_HIDE_MS);
    return () => clearTimeout(timer);
  }, [isCopied, unmarkCopied]);

  const isPreparingHere = Boolean(progress && source && !link
    && progress.container === source.container && progress.node === (source.node || ''));
  const state = link?.state || (isPreparingHere ? 'preparing' : undefined);
  const dateText = (seconds: number) => new Date(seconds * 1000)
    .toLocaleDateString(lang.code, { day: 'numeric', month: 'long', year: 'numeric' });

  const handleCreate = useLastCallback(() => {
    if (source) void createCloudLink(source, ttl);
  });

  const handleCopy = useLastCallback(() => {
    if (!link?.url) return;
    copyTextToClipboard(link.url);
    markCopied();
  });

  const handlePreview = useLastCallback(() => {
    if (link?.url) window.open(link.url, '_blank', 'noopener');
  });

  const handleTtl = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const days = Number(e.currentTarget.dataset.linkTtl);
    if (!link || !isExtending) {
      setTtl(days);
      return;
    }
    markBusy();
    await extendCloudLink(link.id, days);
    unmarkBusy();
    closeExtend();
  });

  const handleRevoke = useLastCallback(async () => {
    closeConfirm();
    if (!link) return;
    markBusy();
    const isDone = await revokeCloudLink(link.id);
    unmarkBusy();
    if (isDone) onRevoked?.();
  });

  const renderTtl = (selected?: number) => (
    <div>
      <div className={styles.caption}>{lang('ParvaneCloudLinkTtl')}</div>
      <div className={seg.root} role="group" aria-label={lang('ParvaneCloudLinkTtl')}>
        {LINK_TTL_DAYS.map((days) => (
          <button
            key={days}
            type="button"
            className={buildClassName(seg.item, selected === days && seg.itemOn)}
            aria-pressed={selected === days}
            disabled={isBusy}
            data-link-ttl={days}
            onClick={handleTtl}
          >
            {lang(CLOUD_LINK_TTL_KEYS[days])}
          </button>
        ))}
      </div>
    </div>
  );

  const termText = !link ? undefined
    : link.state === 'expired' ? lang('ParvaneCloudLinkExpired', { date: dateText(link.expiresAt) })
      : link.expiresAt ? lang('ParvaneCloudLinkUntil', { date: dateText(link.expiresAt) })
        : lang('ParvaneCloudLinkForever');

  return (
    <div className={styles.link} data-link-block data-link-id={link?.id} data-link-state={state}>
      {hasHeading && <div className={styles.linkHead}>{lang('ParvaneCloudLinkHeading')}</div>}
      {!link && !isPreparingHere && (
        <>
          <div className={styles.note}>{lang('ParvaneCloudLinkNote')}</div>
          {renderTtl(ttl)}
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={!source || Boolean(progress)}
            data-link-create
            onClick={handleCreate}
          >
            {lang('ParvaneCloudLinkCreate')}
          </button>
        </>
      )}
      {isPreparingHere && progress && (
        <div
          className={styles.linkProgress}
          role="status"
          data-link-done={progress.done}
          data-link-total={progress.total}
        >
          <span className={kit.grow}>
            {progress.total
              ? lang('ParvaneCloudLinkPreparing', { done: progress.done, total: progress.total })
              : lang('ParvaneCloudLinkPreparingStart')}
          </span>
          <button type="button" className={kit.btn} onClick={cancelCloudLinkCreate}>
            {lang('Cancel')}
          </button>
        </div>
      )}
      {link?.state === 'preparing' && (
        <>
          <div className={styles.note}>{lang('ParvaneCloudLinkUnfinishedNote')}</div>
          <button
            type="button"
            className={buildClassName(kit.btn, styles.danger)}
            disabled={isBusy}
            data-link-revoke
            onClick={openConfirm}
          >
            {lang('ParvaneCloudDelete')}
          </button>
        </>
      )}
      {link && link.state !== 'preparing' && (
        <>
          <div className={styles.note}>{lang('ParvaneCloudLinkKeyNote')}</div>
          {isExtending && (
            <>
              {renderTtl()}
              <div className={styles.note}>{lang('ParvaneCloudLinkExtendHint')}</div>
            </>
          )}
          <div className={styles.linkCard}>
            {link.url ? (
              <div className={styles.linkUrl} dir="ltr" data-link-url>{link.url}</div>
            ) : (
              <div className={styles.note}>{lang('ParvaneCloudLinkNoName')}</div>
            )}
            <div
              className={buildClassName(styles.linkTerm, link.state === 'expired' && styles.linkExpired)}
              data-link-term={link.expiresAt}
            >
              {termText}
              {link.bytes > 0 && ` · ${formatFileSize(lang, link.bytes)}`}
            </div>
          </div>
          {link.url && (
            <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} data-link-copy onClick={handleCopy}>
              {lang(isCopied ? 'ParvaneCloudLinkCopied' : 'ParvaneCloudLinkCopy')}
            </button>
          )}
          <div className={styles.linkPair}>
            <button
              type="button"
              className={kit.btn}
              aria-expanded={isExtending}
              disabled={isBusy}
              data-link-extend
              onClick={isExtending ? closeExtend : openExtend}
            >
              {lang('ParvaneCloudLinkExtend')}
            </button>
            <button
              type="button"
              className={buildClassName(kit.btn, styles.danger)}
              disabled={isBusy}
              data-link-revoke
              onClick={openConfirm}
            >
              {lang('ParvaneCloudLinkRevoke')}
            </button>
          </div>
          {link.url && link.state === 'active' && (
            <button type="button" className={styles.linkPlain} data-link-preview onClick={handlePreview}>
              {lang('ParvaneCloudLinkPreview')}
            </button>
          )}
        </>
      )}
      <ConfirmDialog
        isOpen={isConfirming}
        title={lang('ParvaneCloudLinkRevoke')}
        text={lang('ParvaneCloudLinkRevokeConfirm')}
        confirmLabel={lang('ParvaneCloudLinkRevoke')}
        confirmIsDestructive
        confirmHandler={handleRevoke}
        onClose={closeConfirm}
      />
    </div>
  );
};

export default memo(CloudLinkBlock);
