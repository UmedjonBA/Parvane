import { memo } from '../../../lib/teact/teact';

import type { CloudUsage } from '../../../api/parvane/cloudDrive';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';

import useLang from '../../../hooks/useLang';

import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

type OwnProps = {
  isOpen: boolean;
  usage?: CloudUsage;
  trashBytes: number;
  // Прежние версии файлов личного диска (CLOUD-3)
  versionsBytes: number;
  onOpenTrash: NoneToVoidFunction;
  onOpenLinks: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

// «Что занимает место» (доска `ZdFilesX`, полоса «Место на сервере почти закончилось»): из чего сложено занятое —
// файлы, корзина, ссылки, прежние версии; корзину и ссылки можно открыть и освободить там
const CloudUsageDialog = ({
  isOpen, usage, trashBytes, versionsBytes, onOpenTrash, onOpenLinks, onClose,
}: OwnProps) => {
  const lang = useLang();
  const used = usage?.used || 0;
  const linksBytes = usage?.linksBytes || 0;
  const filesBytes = Math.max(0, used - trashBytes - linksBytes - versionsBytes);
  const rows = [
    { key: 'files', title: lang('ParvaneCloudUsageFilesRow'), bytes: filesBytes },
    {
      key: 'trash', title: lang('ParvaneCloudTabTrash'), bytes: trashBytes, action: lang('ParvaneCloudOpenTrash'),
      onClick: onOpenTrash,
    },
    {
      key: 'links', title: lang('ParvaneCloudLinks'), bytes: linksBytes, action: lang('ParvaneCloudOpenLinks'),
      onClick: onOpenLinks,
    },
    { key: 'versions', title: lang('ParvaneCloudUsageVersionsRow'), bytes: versionsBytes },
  ];

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('ParvaneCloudWhatTakesSpace')}
      subtitle={usage ? lang('ParvaneCloudUsedOf', {
        used: formatFileSize(lang, used), total: formatFileSize(lang, usage.quota),
      }) : undefined}
      className={styles.narrow}
      onClose={onClose}
    >
      <div className={styles.members} role="list" data-cloud-usage-dialog>
        {rows.map((row) => (
          <div key={row.key} className={styles.member} role="listitem" data-usage-row={row.key} data-bytes={row.bytes}>
            <span className={styles.memberText}>
              <span className={styles.memberName}>{row.title}</span>
            </span>
            <span className={styles.usageBytes}>{formatFileSize(lang, row.bytes)}</span>
            {row.onClick && row.bytes > 0 && (
              <button type="button" className={buildClassName(kit.btn)} onClick={row.onClick}>{row.action}</button>
            )}
          </div>
        ))}
      </div>
      <div className={styles.note}>{lang('ParvaneCloudUsageDialogNote')}</div>
    </PvSheet>
  );
};

export default memo(CloudUsageDialog);
