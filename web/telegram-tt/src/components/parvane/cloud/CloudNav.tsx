import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { PvIconName } from '../notes/PvIcon';
import type { CloudTreeRow } from './cloudModel';
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
  // Личный диск: «Мой диск» принимает перетащенные строки (его корень)
  driveId?: string;
  // Компьютер: дерево папок диска под «Моим диском» и открытая папка диска
  tree?: CloudTreeRow[];
  openFolder?: string;
  // Компьютер: блок занятого места внизу колонки
  footer?: TeactNode;
  onPick: (place: CloudNavPlace) => void;
  onPickFolder: (folder: string) => void;
};

// Отступ строки дерева: поле строки и шаг на уровень вложенности (доска `XdFiles`: 24 px у первой ступени)
const TREE_PAD_REM = 1.5;
const TREE_STEP_REM = 0.875;

const PLACES: { place: CloudNavPlace; icon: PvIconName; key: 'ParvaneCloudTabDrive' | 'ParvaneCloudTabOwned'
  | 'ParvaneCloudTabShared' | 'ParvaneCloudLinks' | 'ParvaneCloudTabTrash'; }[] = [
  { place: 'drive', icon: 'folder', key: 'ParvaneCloudTabDrive' },
  { place: 'owned', icon: 'users', key: 'ParvaneCloudTabOwned' },
  { place: 'shared', icon: 'download', key: 'ParvaneCloudTabShared' },
  { place: 'links', icon: 'link', key: 'ParvaneCloudLinks' },
  { place: 'trash', icon: 'trash', key: 'ParvaneCloudTabTrash' },
];

// Места «Файлов» (доски `DeskFiles`, `PhoneFiles`): на компьютере — колонка со счётчиками и занятым местом внизу,
// на телефоне — ряд чипов под шапкой. Под «Моим диском» на компьютере — дерево папок диска: нажатие открывает
// папку, на любую строку можно отпустить перетащенные файлы (атрибуты `data-drop-*`, как у строк списка)
const CloudNav = ({
  place, counts, driveId, tree, openFolder, footer, onPick, onPickFolder,
}: OwnProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.navPlace as CloudNavPlace);
  });

  const handleFolderClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPickFolder(e.currentTarget.dataset.navFolder!);
  });

  function renderTree() {
    if (!tree?.length) return undefined;
    return (
      <div key="tree" className={buildClassName(styles.navTree, 'custom-scroll')} role="group" data-cloud-nav-tree>
        {tree.map((row) => {
          const isOn = place === 'drive' && row.id === openFolder;
          return (
            <button
              key={row.id}
              type="button"
              className={buildClassName(styles.navItem, styles.navFolder, isOn && styles.navItemOn)}
              style={`padding-inline-start: ${TREE_PAD_REM + row.depth * TREE_STEP_REM}rem`}
              aria-current={isOn ? 'true' : undefined}
              data-nav-folder={row.id}
              data-drop-container={driveId}
              data-drop-folder={row.id}
              data-drop-name={row.name}
              onClick={handleFolderClick}
            >
              <span className={styles.navLabel} dir="auto">{row.name}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={styles.nav} role="tablist" aria-label={lang('ParvaneModuleFiles')} data-cloud-nav>
      {PLACES.flatMap((item) => {
        const isSelected = item.place === place;
        // В папке диска подсвечена её строка дерева, а не сам «Мой диск»
        const isOn = isSelected && (item.place !== 'drive' || !openFolder || !tree?.length);
        const count = item.place === 'drive' ? 0 : counts[item.place];
        const button = (
          <button
            key={item.place}
            type="button"
            role="tab"
            aria-selected={isSelected}
            className={buildClassName(styles.navItem, isOn && styles.navItemOn)}
            data-nav-place={item.place}
            data-virtual={item.place === 'drive' ? undefined : item.place}
            data-count={item.place === 'drive' ? undefined : count}
            data-drop-container={item.place === 'drive' ? driveId : undefined}
            data-drop-name={lang(item.key)}
            onClick={handleClick}
          >
            <PvIcon name={item.icon} isSmall className={styles.navIcon} />
            <span className={styles.navLabel}>{lang(item.key)}</span>
            {count > 0 && <span className={styles.navCount}>{count}</span>}
          </button>
        );
        return item.place === 'drive' ? [button, renderTree()] : button;
      })}
      {Boolean(footer) && <span className={styles.navSpace} />}
      {footer}
    </div>
  );
};

export default memo(CloudNav);
