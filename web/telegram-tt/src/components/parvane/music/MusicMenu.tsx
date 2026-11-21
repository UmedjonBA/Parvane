import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';

import type { CloudMenuAnchor } from '../cloud/CloudMenu';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';

import useLastCallback from '../../../hooks/useLastCallback';

import Portal from '../../ui/Portal';
import PvSheet from '../notes/PvSheet';

import sheets from '../cloud/CloudSheets.module.scss';
import styles from './MusicSection.module.scss';

export type MusicMenuAction = {
  key: string;
  title: string;
  glyph?: TeactNode;
  isDanger?: boolean;
  isDisabled?: boolean;
  // Черта перед пунктом (опасные действия — отдельно, доска `ZdMusicX`)
  hasDivider?: boolean;
  // Подменю у курсора: «В плейлист ›»
  submenu?: MusicMenuAction[];
};

type OwnProps = {
  title: string;
  facts?: string;
  // Шторка телефона: обложка слева от названия (доска `XpMusic`)
  cover?: TeactNode;
  actions: MusicMenuAction[];
  anchor?: CloudMenuAnchor;
  footer?: TeactNode;
  onPick: (key: string) => void;
  onClose: NoneToVoidFunction;
};

// Размеры меню у курсора (как в `CloudSheets.module.scss`): по ним меню не выходит за край окна
const POP_ITEM_PX = 36;
const POP_PADDING_PX = 14;
const POP_WIDTH_PX = 264;
const EDGE_PX = 8;

// Parvane (spec 041, доски `XpMusic`, `ZdMusicX`): меню «Музыки» — шторка с обложкой на телефоне, меню у курсора
// на компьютере с подменю («В плейлист ›») и чертой перед удалением. Вид — как у меню «Файлов» (`CloudMenu`)
const MusicMenu = ({
  title, facts, cover, actions, anchor, footer, onPick, onClose,
}: OwnProps) => {
  const [openSub, setOpenSub] = useState<string>();

  useLayoutEffect(() => (anchor ? captureEscKeyListener(onClose) : undefined), [anchor, onClose]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { action, sub } = e.currentTarget.dataset;
    // Подменю открывается и наведением, поэтому нажатие его только открывает (не закрывает)
    if (sub) {
      setOpenSub(action);
      return;
    }
    onPick(action!);
  });

  const handleHover = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { action, sub } = e.currentTarget.dataset;
    setOpenSub(sub ? action : undefined);
  });

  const handleBackdropMenu = useLastCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
  });

  function renderRows(list: MusicMenuAction[], isSub?: boolean) {
    return list.flatMap((action) => [
      action.hasDivider && <div key={`${action.key}-line`} className={styles.menuLine} role="separator" />,
      <button
        key={action.key}
        type="button"
        role="menuitem"
        aria-label={action.title}
        aria-haspopup={action.submenu ? 'menu' : undefined}
        aria-expanded={action.submenu ? openSub === action.key : undefined}
        className={buildClassName(sheets.menuItem, action.isDanger && sheets.menuItemDanger)}
        data-action={action.key}
        data-sub={action.submenu ? true : undefined}
        disabled={action.isDisabled}
        onClick={handlePick}
        onMouseEnter={anchor && !isSub ? handleHover : undefined}
      >
        {action.glyph}
        <span className={sheets.menuLabel}>{action.title}</span>
        {action.submenu && <span className={sheets.menuHint} aria-hidden>›</span>}
      </button>,
    ].filter(Boolean));
  }

  if (!anchor) {
    return (
      <PvSheet isOpen title={cover ? undefined : title} isTight onClose={onClose}>
        {Boolean(cover) && (
          <div className={styles.menuHead}>
            {cover}
            <div className={styles.menuHeadText}>
              <div className={styles.menuHeadTitle}>{title}</div>
              {facts && <div className={sheets.menuFacts}>{facts}</div>}
            </div>
          </div>
        )}
        {!cover && facts && <div className={sheets.menuFacts}>{facts}</div>}
        <div className={sheets.menuList} role="menu" aria-label={title}>{renderRows(actions)}</div>
        {footer}
      </PvSheet>
    );
  }

  const height = actions.length * POP_ITEM_PX + POP_PADDING_PX;
  const left = Math.max(EDGE_PX, Math.min(anchor.x, window.innerWidth - POP_WIDTH_PX - EDGE_PX));
  const top = Math.max(EDGE_PX, Math.min(anchor.y, window.innerHeight - height - EDGE_PX));
  const subIndex = actions.findIndex((action) => action.key === openSub);
  const sub = subIndex >= 0 ? actions[subIndex].submenu : undefined;
  // Подменю справа от меню, если помещается, иначе слева
  const subLeft = left + POP_WIDTH_PX + POP_WIDTH_PX + EDGE_PX > window.innerWidth
    ? Math.max(EDGE_PX, left - POP_WIDTH_PX) : left + POP_WIDTH_PX - EDGE_PX;
  const subHeight = (sub?.length || 0) * POP_ITEM_PX + POP_PADDING_PX;
  const subTop = Math.max(EDGE_PX, Math.min(top + subIndex * POP_ITEM_PX, window.innerHeight - subHeight - EDGE_PX));

  return (
    <Portal>
      <div>
        <div className={sheets.menuBackdrop} onClick={onClose} onContextMenu={handleBackdropMenu} />
        <div
          className={buildClassName(sheets.menuPop, styles.menuPop)}
          role="menu"
          aria-label={title}
          style={`left: ${left}px; top: ${top}px`}
        >
          {renderRows(actions)}
        </div>
        {sub && (
          <div
            className={buildClassName(sheets.menuPop, styles.menuPop)}
            role="menu"
            aria-label={actions[subIndex].title}
            data-music-submenu
            style={`left: ${subLeft}px; top: ${subTop}px`}
          >
            {renderRows(sub, true)}
          </div>
        )}
      </div>
    </Portal>
  );
};

export default memo(MusicMenu);
