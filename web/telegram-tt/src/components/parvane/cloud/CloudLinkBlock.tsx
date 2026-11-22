import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudLinkInfo } from '../../../api/parvane/cloudDrive';
import type { CloudLinkSource } from './cloudStore';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { formatFileSize } from '../../../util/textFormat';
import { LINK_DEFAULT_TTL_DAYS, LINK_TTL_DAYS } from '../../../api/parvane/cloudLinks';
import { formatCloudDayLong } from './cloudFormat';
import {
  cancelCloudLinkCreate, createCloudLink, extendCloudLink, getCloudLinkProgress, getCloudLinks, revokeCloudLink,
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
  // Готовая (либо недоделанная) ссылка; не задана — блок сам создаёт её для `source` со сроком по умолчанию
  link?: CloudLinkInfo;
  source?: CloudLinkSource;
  // Компьютер (доска `DkFilesDialogs`): адрес полем рядом с «Скопировать», состояние и действия одной карточкой
  isWide?: boolean;
  onRevoked?: NoneToVoidFunction;
  // Компьютер: «Готово» внизу окна
  onDone?: NoneToVoidFunction;
};

export const CLOUD_LINK_TTL_KEYS = {
  1: 'ParvaneCloudLinkTtlDay',
  7: 'ParvaneCloudLinkTtlWeek',
  30: 'ParvaneCloudLinkTtlMonth',
  0: 'ParvaneCloudLinkTtlForever',
} as const;
const COPIED_HIDE_MS = 2500;
const DAY_SECONDS = 24 * 60 * 60;

/** Какой срок выделить у готовой ссылки: ближайший из переключателя к сроку от создания до конца. */
export function guessLinkTtl(link: CloudLinkInfo) {
  if (!link.expiresAt) return 0;
  const days = (link.expiresAt - link.createdAt) / DAY_SECONDS;
  return LINK_TTL_DAYS.filter((d) => d > 0)
    .reduce((best, d) => (Math.abs(d - days) < Math.abs(best - days) ? d : best), LINK_DEFAULT_TTL_DAYS);
}

// Блок «Ссылка для людей без аккаунта» (spec 022, доски `PhFilesMore`, `DkFilesDialogs`): окно сразу показывает
// готовую ссылку — её нет, она создаётся при открытии со сроком 7 дней (ход подготовки виден). Переключатель срока
// виден всегда и выделяет действующий срок; нажатие — новый срок от сегодня. Ссылка — снимок: сервер копирует
// файлы, ключ живёт только в адресе после `#`.
const CloudLinkBlock = ({
  link, source, isWide, onRevoked, onDone,
}: OwnProps) => {
  const lang = useLang();
  const progress = useDerivedState(getCloudLinkProgress);
  const links = useDerivedState(getCloudLinks);
  const [ttl, setTtl] = useState<number>(LINK_DEFAULT_TTL_DAYS);
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [isConfirming, openConfirm, closeConfirm] = useFlag();
  const [isCopied, markCopied, unmarkCopied] = useFlag();
  // Создание уже запускалось для этого открытия окна (новое открытие — новый объект источника): после отказа
  // ссылка сама не создаётся снова
  const triedRef = useRef<CloudLinkSource>();
  const [hasFailed, markFailed, unmarkFailed] = useFlag();

  const linkId = link?.id;
  // Срок у готовой ссылки — её собственный; выставляется в кадре появления
  useLayoutEffect(() => {
    unmarkCopied();
    if (link) setTtl(guessLinkTtl(link));
    // Срок пересчитывается только при смене ссылки, не при каждом обновлении списка
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [linkId, unmarkCopied]);

  useEffect(() => {
    if (!isCopied) return undefined;
    const timer = setTimeout(unmarkCopied, COPIED_HIDE_MS);
    return () => clearTimeout(timer);
  }, [isCopied, unmarkCopied]);

  const isPreparingHere = Boolean(progress && source && !link
    && progress.container === source.container && progress.node === (source.node || ''));
  const state = link?.state || (isPreparingHere ? 'preparing' : undefined);
  const areLinksLoaded = links !== undefined;

  const create = useLastCallback(async (days: number) => {
    if (!source) return;
    triedRef.current = source;
    unmarkFailed();
    const created = await createCloudLink(source, days);
    if (!created) markFailed();
  });

  // Ссылки на источник нет — создать сразу (доски открывают окно уже с готовой ссылкой)
  useEffect(() => {
    if (!source || link || progress || !areLinksLoaded || triedRef.current === source) return;
    void create(LINK_DEFAULT_TTL_DAYS);
  }, [source, link, progress, areLinksLoaded, create]);

  const handleRetry = useLastCallback(() => void create(ttl));

  const handleCopy = useLastCallback(() => {
    if (!link?.url) return;
    copyTextToClipboard(link.url);
    markCopied();
  });

  const handlePreview = useLastCallback(() => {
    if (link?.url) window.open(link.url, '_blank', 'noopener');
  });

  const extend = async (days: number) => {
    if (!link) return;
    markBusy();
    setTtl(days);
    await extendCloudLink(link.id, days);
    unmarkBusy();
  };

  const handleTtl = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const days = Number(e.currentTarget.dataset.linkTtl);
    if (link && link.state !== 'preparing') void extend(days);
    else setTtl(days);
  });

  const handleExtend = useLastCallback(() => void extend(ttl));

  const handleRevoke = useLastCallback(async () => {
    closeConfirm();
    if (!link) return;
    markBusy();
    const isDone = await revokeCloudLink(link.id);
    unmarkBusy();
    if (isDone) onRevoked?.();
  });

  const isReady = Boolean(link && link.state !== 'preparing');
  const expiryText = link?.expiresAt ? formatCloudDayLong(lang.code, link.expiresAt * 1000) : '';
  const termText = !link ? undefined
    : link.state === 'expired' ? lang('ParvaneCloudLinkExpired', { date: expiryText })
      : link.expiresAt ? lang('ParvaneCloudLinkUntil', { date: expiryText })
        : lang('ParvaneCloudLinkForever');
  const termParts = link ? [
    termText,
    lang('ParvaneCloudLinkOpens', { count: link.opens }),
    // Телефон (доска `PhFilesMore`) — без размера, компьютер (`DkFilesDialogs`) — с ним
    isWide && link.bytes > 0 && formatFileSize(lang, link.bytes),
  ].filter(Boolean).join(' · ') : undefined;

  const ttlRow = (
    <div>
      <div className={styles.caption}>{lang('ParvaneCloudLinkTtl')}</div>
      <div className={seg.root} role="group" aria-label={lang('ParvaneCloudLinkTtl')}>
        {LINK_TTL_DAYS.map((days) => (
          <button
            key={days}
            type="button"
            className={buildClassName(seg.item, ttl === days && seg.itemOn)}
            aria-pressed={ttl === days}
            disabled={isBusy || isPreparingHere || link?.state === 'preparing'}
            data-link-ttl={days}
            onClick={handleTtl}
          >
            {lang(CLOUD_LINK_TTL_KEYS[days])}
          </button>
        ))}
      </div>
    </div>
  );

  const revokeButton = (
    <button
      type="button"
      className={isWide
        ? buildClassName(styles.linkText, styles.linkTextDanger) : buildClassName(kit.btn, styles.danger)}
      disabled={isBusy}
      data-link-revoke
      onClick={openConfirm}
    >
      {lang('ParvaneCloudLinkRevoke')}
    </button>
  );
  const extendButton = (
    <button
      type="button"
      className={isWide ? styles.linkText : kit.btn}
      disabled={isBusy}
      data-link-extend
      onClick={handleExtend}
    >
      {lang('ParvaneCloudLinkExtend')}
    </button>
  );

  return (
    <div className={styles.link} data-link-block data-link-id={link?.id} data-link-state={state}>
      {link?.state !== 'preparing' && ttlRow}
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
      {!link && !isPreparingHere && hasFailed && (
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={!source || Boolean(progress)}
          data-link-create
          onClick={handleRetry}
        >
          {lang('ParvaneCloudLinkCreate')}
        </button>
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
      {link && isReady && isWide && (
        <>
          {link.url ? (
            <div className={styles.linkField}>
              <input
                className={buildClassName(kit.input, styles.linkInput)}
                value={link.url}
                readOnly
                dir="ltr"
                aria-label={lang('ParvaneCloudLinkShort')}
                data-link-url={link.url}
              />
              <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} data-link-copy onClick={handleCopy}>
                {lang(isCopied ? 'ParvaneCloudLinkCopied' : 'ParvaneCloudLinkCopy')}
              </button>
            </div>
          ) : <div className={styles.note}>{lang('ParvaneCloudLinkNoName')}</div>}
          <div className={buildClassName(styles.linkCard, styles.linkCardRow)}>
            <span className={buildClassName(styles.linkDot, link.state === 'active' && styles.linkDotOn)} />
            <span
              className={buildClassName(styles.linkTerm, kit.grow, link.state === 'expired' && styles.linkExpired)}
              data-link-term={link.expiresAt}
            >
              {termParts}
            </span>
            {extendButton}
            {revokeButton}
          </div>
          <div className={styles.buttons}>
            {link.url && link.state === 'active' && (
              <button
                type="button"
                className={buildClassName(kit.btn, styles.buttonsStart)}
                data-link-preview
                onClick={handlePreview}
              >
                {lang('ParvaneCloudLinkPreview')}
              </button>
            )}
            {onDone && (
              <button type="button" className={kit.btn} data-link-done onClick={onDone}>
                {lang('Done')}
              </button>
            )}
          </div>
        </>
      )}
      {link && isReady && !isWide && (
        <>
          <div className={styles.linkCard}>
            {link.url ? (
              <div className={styles.linkUrl} dir="ltr" data-link-url={link.url}>{link.url}</div>
            ) : (
              <div className={styles.note}>{lang('ParvaneCloudLinkNoName')}</div>
            )}
            <div
              className={buildClassName(styles.linkTerm, link.state === 'expired' && styles.linkExpired)}
              data-link-term={link.expiresAt}
            >
              {termParts}
            </div>
          </div>
          {link.url && (
            <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} data-link-copy onClick={handleCopy}>
              {lang(isCopied ? 'ParvaneCloudLinkCopied' : 'ParvaneCloudLinkCopy')}
            </button>
          )}
          <div className={styles.linkPair}>
            {extendButton}
            {revokeButton}
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
