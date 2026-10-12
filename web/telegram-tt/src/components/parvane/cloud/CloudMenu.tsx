import { memo } from '../../../lib/teact/teact';

import type { PvIconName } from '../notes/PvIcon';

import buildClassName from '../../../util/buildClassName';

import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

export type CloudMenuAction<T extends string = string> = {
  key: T;
  icon: PvIconName;
  title: string;
  isDanger?: boolean;
};

type OwnProps = {
  isOpen: boolean;
  title?: string;
  actions: CloudMenuAction[];
  onPick: (key: string) => void;
  onClose: NoneToVoidFunction;
};

// Шторка действий «⋯»: название файла или папки и строки-действия со значком
const CloudMenu = ({
  isOpen, title, actions, onPick, onClose,
}: OwnProps) => {
  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.action!);
  });

  return (
    <PvSheet isOpen={isOpen} title={title} isTight onClose={onClose}>
      <div className={styles.menu} role="menu" aria-label={title}>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            role="menuitem"
            className={buildClassName(kit.row, action.isDanger && kit.rowRed)}
            data-action={action.key}
            onClick={handlePick}
          >
            <span className={buildClassName(kit.ava, kit.avaM)} style="--c: var(--pv-fg)">
              <PvIcon name={action.icon} isSmall />
            </span>
            <span className={buildClassName(kit.rowText, kit.ttl)}>{action.title}</span>
          </button>
        ))}
      </div>
    </PvSheet>
  );
};

export default memo(CloudMenu);
