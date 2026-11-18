import { memo, useLayoutEffect } from '../../../lib/teact/teact';

import type { PvIconName } from '../notes/PvIcon';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';

import useLastCallback from '../../../hooks/useLastCallback';

import Portal from '../../ui/Portal';
import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';

import styles from './CloudSheets.module.scss';

export type CloudMenuAction<T extends string = string> = {
  key: T;
  icon: PvIconName;
  title: string;
  // Подпись справа: размер, срок ссылки
  hint?: string;
  isDanger?: boolean;
};

export type CloudMenuAnchor = { x: number; y: number };

type OwnProps = {
  isOpen: boolean;
  title?: string;
  // Строка сведений под названием: тип, размер, дата
  facts?: string;
  actions: CloudMenuAction[];
  // Компьютер: меню у этой точки окна; без неё — шторка снизу
  anchor?: CloudMenuAnchor;
  onPick: (key: string) => void;
  onClose: NoneToVoidFunction;
};

// Высота пункта и поля меню у курсора (как в стилях): по ним меню не выходит за край окна
const POP_ITEM_PX = 36;
const POP_PADDING_PX = 14;
const POP_WIDTH_PX = 240;
const EDGE_PX = 8;

// Действия с файлом либо папкой (доски `XpFiles`, `ZdFilesX`): на телефоне — шторка с названием и строкой
// сведений, на компьютере — меню у курсора
const CloudMenu = ({
  isOpen, title, facts, actions, anchor, onPick, onClose,
}: OwnProps) => {
  const isPop = Boolean(anchor);

  // Слушатель ставится в том же кадре, что и меню: иначе Escape сразу после появления меню уходил мимо
  useLayoutEffect(() => (isOpen && isPop ? captureEscKeyListener(onClose) : undefined), [isOpen, isPop, onClose]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.action!);
  });

  const handleBackdropMenu = useLastCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
  });

  const rows = actions.map((action) => (
    <button
      key={action.key}
      type="button"
      role="menuitem"
      aria-label={action.title}
      className={buildClassName(styles.menuItem, action.isDanger && styles.menuItemDanger)}
      data-action={action.key}
      onClick={handlePick}
    >
      <PvIcon name={action.icon} className={styles.menuIcon} />
      <span className={styles.menuLabel}>{action.title}</span>
      {action.hint && <span className={styles.menuHint}>{action.hint}</span>}
    </button>
  ));

  if (!anchor) {
    return (
      <PvSheet isOpen={isOpen} title={title} isTight onClose={onClose}>
        {facts && <div className={styles.menuFacts}>{facts}</div>}
        <div className={styles.menuList} role="menu" aria-label={title}>{rows}</div>
      </PvSheet>
    );
  }

  if (!isOpen) return undefined;

  const height = actions.length * POP_ITEM_PX + POP_PADDING_PX;
  const left = Math.max(EDGE_PX, Math.min(anchor.x, window.innerWidth - POP_WIDTH_PX - EDGE_PX));
  const top = Math.max(EDGE_PX, Math.min(anchor.y, window.innerHeight - height - EDGE_PX));

  return (
    <Portal>
      <div>
        <div className={styles.menuBackdrop} onClick={onClose} onContextMenu={handleBackdropMenu} />
        <div className={styles.menuPop} role="menu" aria-label={title} style={`left: ${left}px; top: ${top}px`}>
          {rows}
        </div>
      </div>
    </Portal>
  );
};

export default memo(CloudMenu);
