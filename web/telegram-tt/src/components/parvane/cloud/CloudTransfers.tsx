import { memo } from '../../../lib/teact/teact';

import type { CloudErrorCode } from '../../../api/parvane/cloudDrive';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { cancelCloudTransfer, getCloudTransfers, retryCloudUpload } from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';

import styles from './Cloud.module.scss';

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

const PROGRESS_KEYS = {
  upload: 'KnowledgeFilesUploading',
  download: 'KnowledgeFilesDownloading',
  move: 'KnowledgeFilesMoving',
  copy: 'ParvaneCloudCopying',
} as const;

const PERCENT = 100;

// Ход загрузок, скачиваний и переносов — строками в списке файлов: полоска, отмена, повтор после сбоя.
// На ход подписан только этот компонент: список файлов от каждого процента не перерисовывается
const CloudTransfers = () => {
  const lang = useLang();
  const transfers = useDerivedState(getCloudTransfers);
  if (!transfers.length) return undefined;

  return (
    <>
      <h3 className={styles.caption}>{lang('ParvaneCloudTransfers')}</h3>
      {transfers.map((t) => {
        const percent = t.total ? Math.min(PERCENT, Math.round((t.done / t.total) * PERCENT)) : 0;
        const isFailed = t.state === 'failed';
        const stateText = t.state === 'done' ? lang('Done')
          : isFailed ? lang(CLOUD_ERROR_KEYS[t.error || 'rejected'])
            : lang(PROGRESS_KEYS[t.kind], { percent, size: formatFileSize(lang, t.total) });
        return (
          <div
            key={t.id}
            className={buildClassName(styles.item, styles.itemPlain, styles.transfer)}
            role="listitem"
            data-transfer-kind={t.kind}
            data-transfer-state={t.state}
            data-name={t.name}
          >
            <span className={buildClassName(styles.dot, isFailed ? styles.dotBad : styles.dotGood)} />
            <span className={styles.itemText}>
              <span className={styles.itemTitle} dir="auto">{t.name}</span>
              <span className={buildClassName(styles.itemSub, isFailed && styles.itemBad)}>{stateText}</span>
            </span>
            {t.state === 'active' && <span className={styles.transferFacts}>{`${percent}%`}</span>}
            {isFailed && t.kind === 'upload' && (
              <button type="button" className={styles.textButton} onClick={() => retryCloudUpload(t.id)}>
                {lang('ParvaneCloudRetry')}
              </button>
            )}
            {t.state !== 'done' && (
              <button type="button" className={styles.textButton} onClick={() => cancelCloudTransfer(t)}>
                {lang(isFailed ? 'ParvaneCloudDismiss' : 'Cancel')}
              </button>
            )}
            {t.state === 'active' && (
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
          </div>
        );
      })}
    </>
  );
};

export default memo(CloudTransfers);
