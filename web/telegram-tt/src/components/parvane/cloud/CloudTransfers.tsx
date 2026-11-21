import { memo } from '../../../lib/teact/teact';

import type { CloudErrorCode } from '../../../api/parvane/cloudDrive';
import type { CloudTransfer } from './cloudStore';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { cancelCloudTransfer, getCloudTransfers, getCloudUsage, retryCloudUpload } from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';

import PvIcon from '../notes/PvIcon';

import styles from './Cloud.module.scss';

type OwnProps = {
  isNarrow?: boolean;
  // «Освободить»: телефон — корзина, компьютер — «Что занимает место»
  onFreeUp: NoneToVoidFunction;
};

export const CLOUD_ERROR_KEYS = {
  offline: 'ParvaneCloudErrorOffline',
  'no-space': 'ParvaneCloudErrorNoSpace',
  'too-large': 'ParvaneCloudErrorTooLarge',
  forbidden: 'ParvaneCloudErrorForbidden',
  rejected: 'ParvaneCloudErrorRejected',
  'not-found': 'ParvaneCloudErrorNotFound',
  'too-many': 'ParvaneCloudErrorTooMany',
  'link-too-many': 'ParvaneCloudLinkErrorTooMany',
  'link-limit': 'ParvaneCloudLinkErrorLimit',
  'link-disabled': 'ParvaneCloudLinkErrorDisabled',
} as const satisfies Record<CloudErrorCode, string>;

// Состояние под полосой хода (доска `PhFilesMore`): «шифруется и загружается»
const STAGE_KEYS = {
  upload: 'ParvaneCloudStageUpload',
  download: 'ParvaneCloudStageDownload',
  move: 'ParvaneCloudStageMove',
  copy: 'ParvaneCloudStageCopy',
} as const;

const PERCENT = 100;

// Ход загрузок, скачиваний и переносов — строками в списке файлов (доски `PhFilesMore`, `ZpFilesX`, `ZdFilesX`):
// справа «64% из 48 МБ», под полосой — что происходит. Сбой загрузки — «не загружен: причина» и одно действие по
// причине: слишком большой файл — только «Убрать», без связи — «Повторить», нет места — «Освободить».
// На ход подписан только этот компонент: список файлов от каждого процента не перерисовывается
const CloudTransfers = ({ isNarrow, onFreeUp }: OwnProps) => {
  const lang = useLang();
  const transfers = useDerivedState(getCloudTransfers);
  const usage = useDerivedState(getCloudUsage);
  if (!transfers.length) return undefined;

  /** Причина сбоя загрузки строчными: «файл больше 4 ГБ», «не хватает 600 МБ», «нет связи». */
  const failText = (t: CloudTransfer) => {
    const error = t.error || 'rejected';
    if (t.kind !== 'upload') return lang(CLOUD_ERROR_KEYS[error]);
    const reason = error === 'too-large' && usage?.maxFile
      ? lang('ParvaneCloudFailTooLarge', { size: formatFileSize(lang, usage.maxFile) })
      : error === 'no-space' && usage
        ? lang('ParvaneCloudFailNoSpace', {
          size: formatFileSize(lang, Math.max(1, t.total - Math.max(0, usage.quota - usage.used))),
        })
        : error === 'offline' ? lang('ParvaneCloudFailOffline') : undefined;
    return reason ? lang('ParvaneCloudFailed', { reason }) : lang(CLOUD_ERROR_KEYS[error]);
  };

  return (
    <>
      <h3 className={styles.caption}>{lang('ParvaneCloudTransfers')}</h3>
      {transfers.map((t) => {
        const percent = t.total ? Math.min(PERCENT, Math.round((t.done / t.total) * PERCENT)) : 0;
        const isFailed = t.state === 'failed';
        const isActive = t.state === 'active';
        const error = isFailed ? t.error || 'rejected' : undefined;
        const canRetry = isFailed && t.kind === 'upload' && error !== 'too-large' && error !== 'no-space';
        const canFree = isFailed && t.kind === 'upload' && error === 'no-space';
        // Единственное действие сбоя по доске — «Убрать» у слишком большого файла; у прочих «Убрать» — значком
        const isDismissMain = isFailed && !canRetry && !canFree;
        return (
          <div
            key={t.id}
            className={buildClassName(
              styles.item, styles.itemPlain, styles.transfer, isActive && styles.itemUnavailable,
            )}
            role="listitem"
            aria-disabled={isActive || undefined}
            data-transfer-kind={t.kind}
            data-transfer-state={t.state}
            data-transfer-error={error}
            data-name={t.name}
          >
            <span className={buildClassName(styles.dot, isFailed ? styles.dotBad : styles.dotGood)} />
            <span className={styles.itemText}>
              <span className={styles.itemTitle} dir="auto">{t.name}</span>
              {!isActive && (
                <span className={buildClassName(styles.itemSub, isFailed && styles.itemBad)}>
                  {isFailed ? failText(t) : lang('Done')}
                </span>
              )}
            </span>
            {isActive && (
              <span className={styles.transferFacts}>
                {lang('ParvaneCloudProgressOf', { percent, size: formatFileSize(lang, t.total) })}
              </span>
            )}
            {canRetry && (
              <button type="button" className={styles.textButton} onClick={() => retryCloudUpload(t.id)}>
                {lang('ParvaneCloudRetry')}
              </button>
            )}
            {canFree && (
              <button type="button" className={styles.textButton} data-transfer-free onClick={onFreeUp}>
                {lang(isNarrow ? 'ParvaneCloudFreeUp' : 'ParvaneCloudFreeUpSpace')}
              </button>
            )}
            {isDismissMain && (
              <button type="button" className={styles.textButton} onClick={() => cancelCloudTransfer(t)}>
                {lang('ParvaneCloudDismiss')}
              </button>
            )}
            {(isActive || (isFailed && !isDismissMain)) && (
              <button
                type="button"
                className={styles.transferIcon}
                aria-label={lang(isFailed ? 'ParvaneCloudDismiss' : 'Cancel')}
                onClick={() => cancelCloudTransfer(t)}
              >
                <PvIcon name="x" isSmall />
              </button>
            )}
            {isActive && (
              <span
                className={styles.transferBar}
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={PERCENT}
                aria-label={t.name}
              >
                <span className={styles.transferBarFill} style={`width: ${percent}%`} />
              </span>
            )}
            {isActive && <span className={styles.transferStage}>{lang(STAGE_KEYS[t.kind])}</span>}
          </div>
        );
      })}
    </>
  );
};

export default memo(CloudTransfers);
