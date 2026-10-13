import { memo } from '../../../lib/teact/teact';

import type { CloudErrorCode } from '../../../api/parvane/cloudDrive';
import type { CloudTransfer } from './cloudStore';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { cancelCloudTransfer, retryCloudUpload } from './cloudStore';

import useLang from '../../../hooks/useLang';

import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type OwnProps = {
  transfers: CloudTransfer[];
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

const PROGRESS_KEYS = {
  upload: 'KnowledgeFilesUploading',
  download: 'KnowledgeFilesDownloading',
  move: 'KnowledgeFilesMoving',
} as const;

const PERCENT = 100;

// Ход загрузок, скачиваний и переносов — строками в списке файлов: полоска, отмена, повтор после сбоя
const CloudTransfers = ({ transfers }: OwnProps) => {
  const lang = useLang();
  if (!transfers.length) return undefined;

  return (
    <>
      {transfers.map((t) => {
        const percent = t.total ? Math.min(PERCENT, Math.round((t.done / t.total) * PERCENT)) : 0;
        const stateText = t.state === 'done' ? lang('Done')
          : t.state === 'failed' ? lang(CLOUD_ERROR_KEYS[t.error || 'rejected'])
            : lang(PROGRESS_KEYS[t.kind], { percent, size: formatFileSize(lang, t.total) });
        return (
          <div
            key={t.id}
            className={buildClassName(
              styles.plainRow, styles.transfer, t.state === 'failed' && styles.transferFailed,
            )}
            role="listitem"
            data-transfer-kind={t.kind}
            data-transfer-state={t.state}
            data-name={t.name}
          >
            <span className={kit.ava} style="--c: var(--pv-blue)">
              <PvIcon name={t.kind === 'upload' ? 'upload' : t.kind === 'move' ? 'move' : 'download'} isSmall />
            </span>
            <span className={kit.rowText}>
              <span className={kit.ttl} dir="auto">{t.name}</span>
              {t.state === 'active' && (
                <span className={styles.transferBar}>
                  <span className={styles.transferBarFill} style={`width: ${percent}%`} />
                </span>
              )}
              <span className={buildClassName(kit.sub, styles.transferState)}>{stateText}</span>
            </span>
            {t.state === 'failed' && t.kind === 'upload' && (
              <button
                type="button"
                className={buildClassName(kit.btn, kit.btnGhost)}
                onClick={() => retryCloudUpload(t.id)}
              >
                {lang('ParvaneCloudRetry')}
              </button>
            )}
            {t.state !== 'done' && (
              <button
                type="button"
                className={kit.ib}
                aria-label={lang('Cancel')}
                onClick={() => cancelCloudTransfer(t)}
              >
                <PvIcon name="x" isSmall />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
};

export default memo(CloudTransfers);
