import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { PvIconName } from '../notes/PvIcon';
import type { CloudVirtualFolder } from './cloudStore';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import styles from './Cloud.module.scss';

export type CloudNavPlace = 'drive' | CloudVirtualFolder;
export type CloudNavCounts = Record<CloudVirtualFolder, number>;

type OwnProps = {
  place: CloudNavPlace;
  counts: CloudNavCounts;
  // Компьютер: блок занятого места внизу колонки
  footer?: TeactNode;
  onPick: (place: CloudNavPlace) => void;
};

const PLACES: { place: CloudNavPlace; icon: PvIconName; key: 'ParvaneCloudTabDrive' | 'ParvaneCloudTabOwned'
  | 'ParvaneCloudTabShared' | 'ParvaneCloudLinks' | 'ParvaneCloudTabTrash'; }[] = [
  { place: 'drive', icon: 'folder', key: 'ParvaneCloudTabDrive' },
  { place: 'owned', icon: 'users', key: 'ParvaneCloudTabOwned' },
  { place: 'shared', icon: 'download', key: 'ParvaneCloudTabShared' },
  { place: 'links', icon: 'link', key: 'ParvaneCloudLinks' },
  { place: 'trash', icon: 'trash', key: 'ParvaneCloudTabTrash' },
];

// Места «Файлов» (доски `DeskFiles`, `PhoneFiles`): на компьютере — колонка со счётчиками и занятым местом внизу,
// на телефоне — ряд чипов под шапкой
const CloudNav = ({
  place, counts, footer, onPick,
}: OwnProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.navPlace as CloudNavPlace);
  });

  return (
    <div className={styles.nav} role="tablist" aria-label={lang('ParvaneModuleFiles')} data-cloud-nav>
      {PLACES.map((item) => {
        const isOn = item.place === place;
        const count = item.place === 'drive' ? 0 : counts[item.place];
        return (
          <button
            key={item.place}
            type="button"
            role="tab"
            aria-selected={isOn}
            className={buildClassName(styles.navItem, isOn && styles.navItemOn)}
            data-nav-place={item.place}
            data-virtual={item.place === 'drive' ? undefined : item.place}
            data-count={item.place === 'drive' ? undefined : count}
            onClick={handleClick}
          >
            <PvIcon name={item.icon} isSmall className={styles.navIcon} />
            <span className={styles.navLabel}>{lang(item.key)}</span>
            {count > 0 && <span className={styles.navCount}>{count}</span>}
          </button>
        );
      })}
      {Boolean(footer) && <span className={styles.navSpace} />}
      {footer}
    </div>
  );
};

export default memo(CloudNav);
