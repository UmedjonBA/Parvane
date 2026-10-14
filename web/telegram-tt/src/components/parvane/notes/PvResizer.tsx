import { memo, useRef } from '../../../lib/teact/teact';

import type { ParvanePanel } from '../../../util/parvanePanels';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';
import buildClassName from '../../../util/buildClassName';
import {
  applyPanelWidths, clampPanelWidth, savePanelWidth, showPanelWidth,
} from '../../../util/parvanePanels';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from './PvKit.module.scss';

type OwnProps = {
  panel: ParvanePanel;
  // С какой стороны панели стоит ручка: `start` — панель справа от неё (тянут влево — шире)
  edge: 'start' | 'end';
  min: number;
  max: number;
  // Чью ширину меняет ручка: своего родителя либо соседа перед собой (ручка лежит рядом с прокручиваемой панелью)
  target?: 'parent' | 'previous';
  className?: string;
};

const KEY_STEP = 16;
// Пределы ширины правой колонки «Плана» (px): панель дня, карточка записи, колонка «Сегодня»
export const PLANNER_SIDE_MIN = 300;
export const PLANNER_SIDE_MAX = 640;

applyPanelWidths();

// Ручка на границе панели: перетаскивание меняет ширину, двойное нажатие возвращает ширину из стилей.
// Ставится только на широком экране — на телефонной раскладке панели занимают весь экран
const PvResizer = ({
  panel, edge, min, max, target = 'parent', className,
}: OwnProps) => {
  const lang = useLang();
  const dragRef = useRef<{ x: number; width: number; last: number }>();

  const widthOf = (handle: HTMLElement) => (
    (target === 'previous' ? handle.previousElementSibling : handle.parentElement) as HTMLElement
  ).offsetWidth;

  const fit = (width: number) => clampPanelWidth(width, min, max, window.innerWidth);

  const handleDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const width = widthOf(e.currentTarget);
    dragRef.current = { x: e.clientX, width, last: width };
    requestMutation(() => document.body.classList.add('cursor-ew-resize'));
  });

  const handleMove = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const isReversed = (edge === 'start') !== (document.documentElement.dir === 'rtl');
    const delta = e.clientX - drag.x;
    drag.last = fit(drag.width + (isReversed ? -delta : delta));
    const { last } = drag;
    requestMutation(() => showPanelWidth(panel, last));
  });

  const handleUp = useLastCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = undefined;
    requestMutation(() => document.body.classList.remove('cursor-ew-resize'));
    if (drag.last !== drag.width) savePanelWidth(panel, drag.last);
  });

  const handleReset = useLastCallback(() => savePanelWidth(panel));

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const isReversed = (edge === 'start') !== (document.documentElement.dir === 'rtl');
    const step = (e.key === 'ArrowRight') !== isReversed ? KEY_STEP : -KEY_STEP;
    savePanelWidth(panel, fit(widthOf(e.currentTarget) + step));
  });

  return (
    <div
      className={buildClassName(kit.resizer, edge === 'start' ? kit.resizerStart : kit.resizerEnd, className)}
      role="separator"
      aria-orientation="vertical"
      aria-label={lang('ParvaneResizePanel')}
      title={lang('ParvaneResizePanel')}
      tabIndex={0}
      data-pv-resizer={panel}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onDoubleClick={handleReset}
      onKeyDown={handleKey}
    />
  );
};

export default memo(PvResizer);
