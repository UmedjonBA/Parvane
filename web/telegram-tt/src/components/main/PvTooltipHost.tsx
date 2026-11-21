import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { PvTip } from '../../util/pvTip';

import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import { findTip, formatShortcut, TIP_DELAY_MS } from '../../util/pvTip';

import styles from './PvTooltipHost.module.scss';

type Shown = PvTip & { x: number; y: number; isAbove: boolean };

// Отступ подсказки от кнопки и запас до низа окна, px
const TIP_GAP = 6;
const TIP_ROOM = 40;

// Подсказка при наведении мышью (доска `ZdMisc`): одна на всё приложение, через полсекунды под кнопкой — название
// действия и клавиша. Нажатие, прокрутка и клавиатура её убирают. Без анимации — по правилу доски
const PvTooltipHost = () => {
  const [shown, setShown] = useState<Shown | undefined>();

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | undefined;

    function hide() {
      window.clearTimeout(timer);
      timer = undefined;
      current = undefined;
      setShown(undefined);
    }

    function handleOver(e: PointerEvent) {
      if (e.pointerType !== 'mouse') return;
      const found = findTip(e.target);
      if (found?.element === current) return;
      hide();
      if (!found) return;
      current = found.element;
      timer = window.setTimeout(() => {
        const element = current;
        if (!element?.isConnected) return;
        const rect = element.getBoundingClientRect();
        const isAbove = rect.bottom + TIP_ROOM > window.innerHeight;
        const kbd = found.element.getAttribute('aria-keyshortcuts');
        setShown({
          ...found.tip,
          kbd: kbd ? formatShortcut(kbd, IS_MAC_OS) : found.tip.kbd,
          x: rect.left + rect.width / 2,
          y: isAbove ? rect.top - TIP_GAP : rect.bottom + TIP_GAP,
          isAbove,
        });
      }, TIP_DELAY_MS);
    }

    function handleOut(e: PointerEvent) {
      if (!current || (e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) return;
      hide();
    }

    document.addEventListener('pointerover', handleOver);
    document.addEventListener('pointerout', handleOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('scroll', hide, true);
    return () => {
      hide();
      document.removeEventListener('pointerover', handleOver);
      document.removeEventListener('pointerout', handleOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!shown) return undefined;

  return (
    <div
      className={styles.root}
      style={`left: ${shown.x}px; top: ${shown.y}px; transform: translate(-50%, ${shown.isAbove ? '-100%' : '0'})`}
      role="tooltip"
      data-pv-tooltip
    >
      <span className={styles.text}>{shown.text}</span>
      {shown.kbd && <kbd className={styles.kbd}>{shown.kbd}</kbd>}
    </div>
  );
};

export default memo(PvTooltipHost);
