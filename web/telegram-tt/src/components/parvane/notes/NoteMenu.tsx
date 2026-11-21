import { memo, useLayoutEffect } from '../../../lib/teact/teact';

import type { PvIconName } from './PvIcon';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';

import useLastCallback from '../../../hooks/useLastCallback';

import Portal from '../../ui/Portal';
import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './NoteView.module.scss';

export type NoteMenuItem = {
  action: string;
  label: string;
  icon: PvIconName;
  isDanger?: boolean;
  // Меню у строки: сочетание клавиш справа и черта над пунктом (доска `ZdNotesX`)
  hint?: string;
  hasDivider?: boolean;
};

export type NoteMenuAnchor = { x: number; y: number };

// Высота пункта, поля и ширина меню у строки (как в стилях): по ним меню не выходит за край окна
const POP_ITEM_PX = 36;
const POP_PADDING_PX = 14;
const POP_WIDTH_PX = 264;
const EDGE_PX = 8;

type OwnProps = {
  isOpen: boolean;
  title: string;
  // Шторка телефона: строка под названием («папка · N связей», доска `XpNotes`)
  subtitle?: string;
  items: NoteMenuItem[];
  // Телефон и панель графа: шторка снизу; иначе — меню под кнопкой
  isSheet?: boolean;
  // Меню строки списка на компьютере: у этой точки окна, без значков, с сочетаниями клавиш
  anchor?: NoteMenuAnchor;
  onPick: (action: string) => void;
  onClose: NoneToVoidFunction;
};

// Действия с заметкой (доски `XpNotes`, `ZdNotesX`): на телефоне — шторка, на компьютере — меню под кнопкой «Ещё»
const NoteMenu = ({
  isOpen, title, subtitle, items, isSheet, anchor, onPick, onClose,
}: OwnProps) => {
  const isPop = Boolean(anchor) && !isSheet;
  // Escape закрывает открытое меню (шторку закрывает само окно)
  // Слушатель ставится в том же кадре, что и меню: иначе Escape сразу после появления меню уходил мимо
  useLayoutEffect(() => (isOpen && !isSheet ? captureEscKeyListener(onClose) : undefined), [isOpen, isSheet, onClose]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onClose();
    onPick(e.currentTarget.dataset.noteAction!);
  });

  const handleBackdropMenu = useLastCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
  });

  const rows = items.map((item) => (
    <button
      key={item.action}
      type="button"
      role="menuitem"
      className={buildClassName(
        styles.menuItem, item.isDanger && styles.menuItemDanger, isPop && item.hasDivider && styles.menuItemDivided,
      )}
      data-note-action={item.action}
      onClick={handlePick}
    >
      {!isPop && <PvIcon name={item.icon} />}
      <span className={styles.menuLabel}>{item.label}</span>
      {isPop && item.hint && <kbd className={styles.menuHint}>{item.hint}</kbd>}
    </button>
  ));

  if (isSheet) {
    return (
      <PvSheet isOpen={isOpen} title={title} subtitle={subtitle} isTight onClose={onClose}>
        <div className={styles.menuSheet} role="menu" data-note-menu-list>{rows}</div>
      </PvSheet>
    );
  }

  if (!isOpen) return undefined;

  if (isPop) {
    const height = items.length * POP_ITEM_PX + POP_PADDING_PX;
    const left = Math.max(EDGE_PX, Math.min(anchor.x, window.innerWidth - POP_WIDTH_PX - EDGE_PX));
    const top = Math.max(EDGE_PX, Math.min(anchor.y, window.innerHeight - height - EDGE_PX));
    return (
      <Portal>
        <div>
          <div className={styles.menuPopBackdrop} onClick={onClose} onContextMenu={handleBackdropMenu} />
          <div
            className={styles.menuPop}
            role="menu"
            aria-label={title}
            data-note-menu-list
            data-note-menu-pop
            style={`left: ${left}px; top: ${top}px`}
          >
            {rows}
          </div>
        </div>
      </Portal>
    );
  }

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
