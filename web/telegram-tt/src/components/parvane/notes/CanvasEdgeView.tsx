import { memo } from '../../../lib/teact/teact';

import type { CanvasEdge, CanvasNode } from './notesCanvas';

import { edgeAnchors } from './notesCanvas';
import { curveBetween, curvePoint } from './notesCanvasEdit';
import { arrowPath, colorStyle, curvePath } from './notesCanvasLook';

import styles from './Knowledge.module.scss';

type OwnProps = {
  edge: CanvasEdge;
  from: CanvasNode;
  to: CanvasNode;
  isOn: boolean;
  // Подпись правится на месте — в самой стрелке её не видно
  isLabelHidden: boolean;
};

const EDGE_LABEL_SHIFT = 4;

// Стрелка холста. Перерисовывается, только когда сменились она сама, один из её узлов или выделение:
// сдвиг и масштаб поля, движение других карточек её не трогают
const CanvasEdgeView = ({
  edge, from, to, isOn, isLabelHidden,
}: OwnProps) => {
  const anchors = edgeAnchors(from, to, edge);
  const curve = curveBetween(anchors.from, anchors.to);
  const hasStartArrow = edge.fromEnd === 'arrow';
  const hasEndArrow = edge.toEnd !== 'none';
  const path = curvePath(curve, hasStartArrow, hasEndArrow);
  const label = curvePoint(curve, 0.5);
  return (
    <g
      data-canvas-edge={edge.id}
      data-canvas-ends={`${hasStartArrow ? 'arrow' : 'none'}-${hasEndArrow ? 'arrow' : 'none'}`}
      // Класс у узла SVG всегда строка: снять его совсем Teact не умеет (свойство `className` там только
      // для чтения) — отрисовка падала, и холст замирал, стоило снять выделение со стрелки
      className={isOn ? styles.canvasEdgeOn : ''}
      style={colorStyle(edge.color) || undefined}
    >
      <path className={styles.canvasEdgeHit} d={path} />
      <path className={styles.canvasEdge} d={path} />
      {hasStartArrow && <path className={styles.canvasArrow} d={arrowPath(curve.p)} />}
      {hasEndArrow && <path className={styles.canvasArrow} d={arrowPath(curve.q)} />}
      {edge.label && !isLabelHidden && (
        <text className={styles.canvasEdgeLabel} x={label.x} y={label.y + EDGE_LABEL_SHIFT}>
          {edge.label}
        </text>
      )}
    </g>
  );
};

export default memo(CanvasEdgeView);
