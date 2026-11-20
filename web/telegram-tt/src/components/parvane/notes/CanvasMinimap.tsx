import type { ElementRef } from '../../../lib/teact/teact';
import { memo, useRef, useState } from '../../../lib/teact/teact';

import type { BoardView } from './boardView';
import type { CanvasNode } from './notesCanvas';

import { colorStyle } from './notesCanvasLook';
import { minimapFrame, viewFromMinimap } from './notesCanvasMinimap';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useResizeObserver from '../../../hooks/useResizeObserver';

import styles from './CanvasParts.module.scss';

type OwnProps = {
  nodes: CanvasNode[];
  view: BoardView;
  boardRef: ElementRef<HTMLDivElement>;
  onView: (view: BoardView) => void;
};

// Мини-карта холста на компьютере: все карточки и рамка видимой части; нажатие и протяжка по ней двигают поле
const CanvasMinimap = ({
  nodes, view, boardRef, onView,
}: OwnProps) => {
  const lang = useLang();
  const ref = useRef<HTMLDivElement>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const isDraggingRef = useRef(false);

  useResizeObserver(boardRef, (entry) => {
    setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
  });

  const frame = size.width ? minimapFrame(nodes, view, size.width, size.height) : undefined;

  const moveTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !frame) return;
    onView(viewFromMinimap(
      frame, (e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height, box.width / box.height,
      view, size.width, size.height,
    ));
  };

  const handlePointerDown = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    moveTo(e);
  });

  const handlePointerMove = useLastCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) moveTo(e);
  });

  const handlePointerUp = useLastCallback(() => {
    isDraggingRef.current = false;
  });

  if (!frame || !nodes.length) return undefined;
  const { box, visible } = frame;

  return (
    <div
      ref={ref}
      className={styles.minimap}
      role="img"
      aria-label={lang('KnowledgeCanvasMinimap')}
      data-board-tools
      data-canvas-minimap
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <svg className={styles.minimapSvg} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}>
        {nodes.map((node) => (
          <rect
            key={node.id}
            className={node.type === 'group' ? styles.minimapGroup : styles.minimapCard}
            style={colorStyle(node.color) || undefined}
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={8}
          />
        ))}
        <rect
          className={styles.minimapView}
          x={visible.x}
          y={visible.y}
          width={visible.width}
          height={visible.height}
          data-canvas-minimap-view
        />
      </svg>
    </div>
  );
};

export default memo(CanvasMinimap);
