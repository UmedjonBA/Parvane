import { memo } from '../../../lib/teact/teact';

import type { CloudUsage as CloudUsageInfo } from '../../../api/parvane/cloudDrive';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';

import useLang from '../../../hooks/useLang';

import styles from './Cloud.module.scss';

type OwnProps = {
  usage: CloudUsageInfo;
  trashBytes: number;
  // Телефон: блок стоит в конце списка, справа место под «+»
  isInList?: boolean;
};

const USAGE_WARN_SHARE = 0.9;
const PERCENT = 100;

export function getIsCloudAlmostFull(usage?: CloudUsageInfo) {
  return Boolean(usage && usage.quota > 0 && usage.used / usage.quota >= USAGE_WARN_SHARE);
}

// «Занято N из M»: полоса и строка о шифровании; когда место кончается — красным, с долями корзины и ссылок
const CloudUsage = ({ usage, trashBytes, isInList }: OwnProps) => {
  const lang = useLang();
  const isWarn = getIsCloudAlmostFull(usage);
  const share = Math.min(1, usage.used / usage.quota);
  // «Корзина: 2,2 ГБ · ссылки: 1,4 ГБ» (доска `RdFiles`): заглавная — только у первой части
  const partsText = [
    trashBytes > 0 && lang('ParvaneCloudUsageTrash', { size: formatFileSize(lang, trashBytes) }),
    usage.linksBytes > 0 && lang('ParvaneCloudUsageLinks', { size: formatFileSize(lang, usage.linksBytes) }),
  ].filter(Boolean).join(' · ');
  const partsShown = partsText && `${partsText[0].toLocaleUpperCase()}${partsText.slice(1)}`;

  return (
    <footer
      className={buildClassName(styles.usage, isInList && styles.usageInList, isWarn && styles.usageWarn)}
      data-used={usage.used}
      data-quota={usage.quota}
      data-links-bytes={usage.linksBytes}
    >
      <div className={styles.usageHead}>
        <span className={styles.usageTitle}>{lang('ParvaneCloudUsed')}</span>
        <span className={styles.usageValue}>
          {lang('ParvaneCloudUsedOf', {
            used: formatFileSize(lang, usage.used), total: formatFileSize(lang, usage.quota),
          })}
        </span>
      </div>
      <div className={styles.usageBar} aria-hidden="true">
        <div className={styles.usageFill} style={`width: ${Math.round(share * PERCENT)}%`} />
      </div>
      <div className={styles.usageNote}>
        {isWarn && <span className={styles.usageAlert}>{`${lang('ParvaneCloudUsageAlmostFull')} `}</span>}
        {partsShown && <span>{`${partsShown}. `}</span>}
        {!isWarn && <span>{lang('ParvaneCloudEncryptedNote')}</span>}
      </div>
    </footer>
  );
};

export default memo(CloudUsage);
