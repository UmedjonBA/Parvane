import { memo, useLayoutEffect } from '../../../lib/teact/teact';

import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';

import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './NoteView.module.scss';

export type NoteMenuItem = { action: string; label: string; icon: PvIconName; isDanger?: boolean };

type OwnProps = {
  isOpen: boolean;
  title: string;
  items: NoteMenuItem[];
  // Телефон и панель графа: шторка снизу; иначе — меню под кнопкой
  isSheet?: boolean;
  onPick: (action: string) => void;
  onClose: NoneToVoidFunction;
};

// Действия с заметкой (доски `XpNotes`, `ZdNotesX`): на телефоне — шторка, на компьютере — меню под кнопкой «Ещё»
const NoteMenu = ({
  isOpen, title, items, isSheet, onPick, onClose,
}: OwnProps) => {
  // Escape закрывает открытое меню (шторку закрывает само окно)
  // Слушатель ставится в том же кадре, что и меню: иначе Escape сразу после появления меню уходил мимо
  useLayoutEffect(() => (isOpen && !isSheet ? captureEscKeyListener(onClose) : undefined), [isOpen, isSheet, onClose]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onClose();
    onPick(e.currentTarget.dataset.noteAction!);
  });

  const rows = items.map((item) => (
    <button
      key={item.action}
      type="button"
      role="menuitem"
      className={buildClassName(styles.menuItem, item.isDanger && styles.menuItemDanger)}
      data-note-action={item.action}
      onClick={handlePick}
    >
      <PvIcon name={item.icon} />
      {item.label}
    </button>
  ));

  if (isSheet) {
    return (
      <PvSheet isOpen={isOpen} title={title} isTight onClose={onClose}>
        <div className={styles.menuSheet} role="menu" data-note-menu-list>{rows}</div>
      </PvSheet>
    );
  }

  if (!isOpen) return undefined;

  return (
    <>
      <div className={styles.menuBackdrop} onClick={onClose} />
      <div className={styles.menu} role="menu" data-note-menu-list>
        {rows}
      </div>
    </>
  );
};

export default memo(NoteMenu);
