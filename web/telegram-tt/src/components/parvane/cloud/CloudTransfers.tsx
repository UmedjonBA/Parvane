import { memo } from '../../../lib/teact/teact';

import type { CloudErrorCode } from '../../../api/parvane/cloudDrive';
import type { CloudTransfer } from './cloudStore';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { cancelCloudTransfer, retryCloudUpload } from './cloudStore';

import useLang from '../../../hooks/useLang';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';

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
} as const satisfies Record<CloudErrorCode, string>;

const PERCENT = 100;

// Ход загрузок и скачиваний: строка на файл, отмена, повтор после сбоя
const CloudTransfers = ({ transfers }: OwnProps) => {
  const lang = useLang();
  if (!transfers.length) return undefined;

  return (
    <div className={styles.transfers} role="list" aria-label={lang('ParvaneCloudUpload')}>
      {transfers.map((t) => {
        const percent = t.total ? Math.min(PERCENT, Math.round((t.done / t.total) * PERCENT)) : 0;
        const stateText = t.state === 'done' ? lang('ParvaneCloudTransferDone')
          : t.state === 'failed' ? lang(CLOUD_ERROR_KEYS[t.error || 'rejected'])
            : `${percent}% · ${formatFileSize(lang, t.total)}`;
        return (
          <div
            key={t.id}
            className={buildClassName(styles.transfer, t.state === 'failed' && styles.transferFailed)}
            role="listitem"
            data-transfer-kind={t.kind}
            data-transfer-state={t.state}
            data-name={t.name}
          >
            <Icon name={t.kind === 'upload' ? 'up' : 'download'} className={styles.transferIcon} />
            <div className={styles.transferText}>
              <div className={styles.transferName} dir="auto">{t.name}</div>
              <div className={styles.transferState}>{stateText}</div>
              {t.state === 'active' && (
                <div className={styles.transferBar}>
                  <div className={styles.transferBarFill} style={`width: ${percent}%`} />
                </div>
              )}
            </div>
            {t.state === 'failed' && t.kind === 'upload' && (
              <Button size="tiny" isText onClick={() => retryCloudUpload(t.id)}>{lang('ParvaneCloudRetry')}</Button>
            )}
            {t.state !== 'done' && (
              <Button
                round
                size="tiny"
                color="translucent"
                iconName="close"
                ariaLabel={lang('ParvaneCloudCancel')}
                onClick={() => cancelCloudTransfer(t)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default memo(CloudTransfers);
