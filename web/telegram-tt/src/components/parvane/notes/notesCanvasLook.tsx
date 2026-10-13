// Parvane, раздел «Знания»: внешний вид холста, общий для поля и его карточек — цвета JSON Canvas, стиль цвета
// узла, разметка строки карточки, линии стрелок. Без состояния

import type { TeactNode } from '../../../lib/teact/teact';

import type { CanvasPoint, CanvasPresetColor, CanvasSide } from './notesCanvas';
import type { CanvasCurve } from './notesCanvasEdit';

import { isCanvasPresetColor } from './notesCanvas';
import { CANVAS_SIDE_NORMALS } from './notesCanvasEdit';

import styles from './Knowledge.module.scss';

const ARROW_LENGTH = 11;
const ARROW_HALF_WIDTH = 5;
const CARD_INLINE = /(\[\[[^\]\n]+\]\]|`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

// Цвета JSON Canvas 1…6: красный, оранжевый, жёлтый, зелёный, синий, фиолетовый
export const CANVAS_TONES: Record<CanvasPresetColor, string> = {
  1: 'var(--pv-red)',
  2: 'var(--pv-orange)',
  3: 'var(--pv-yellow)',
  4: 'var(--pv-green)',
  5: 'var(--pv-blue)',
  6: 'var(--pv-purple)',
};

export function colorStyle(color?: string) {
  return isCanvasPresetColor(color) ? `--gc: ${CANVAS_TONES[color]}; ` : '';
}

export function renderCardInline(text: string): TeactNode {
  return text.split(CARD_INLINE).map((part, i) => {
    const key = `${i}${part}`;
    if (part.startsWith('[[')) {
      const [target, alias] = part.slice(2, -2).split('|');
      return <span key={key} className={styles.cardLink}>{(alias || target).trim()}</span>;
    }
    if (part.startsWith('`')) return <code key={key} className={styles.code}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <b key={key}>{part.slice(2, -2)}</b>;
    return part;
  });
}

// Треугольник наконечника: остриё в конце стрелки, основание отведено от стороны узла наружу
export function arrowPath(anchor: CanvasPoint & { side: CanvasSide }) {
  const normal = CANVAS_SIDE_NORMALS[anchor.side];
  const baseX = anchor.x + normal.x * ARROW_LENGTH;
  const baseY = anchor.y + normal.y * ARROW_LENGTH;
  const sideX = normal.y * ARROW_HALF_WIDTH;
  const sideY = normal.x * ARROW_HALF_WIDTH;
  return `M${anchor.x} ${anchor.y}L${baseX + sideX} ${baseY + sideY}L${baseX - sideX} ${baseY - sideY}z`;
}

export function curvePath({
  p, c1, c2, q,
}: CanvasCurve, hasStartArrow: boolean, hasEndArrow: boolean) {
  // Линия кончается у основания наконечника, чтобы не торчать из его острия
  const cut = (anchor: CanvasCurve['p'], hasArrow: boolean) => {
    const normal = CANVAS_SIDE_NORMALS[anchor.side];
    const by = hasArrow ? ARROW_LENGTH - 1 : 0;
    return `${anchor.x + normal.x * by} ${anchor.y + normal.y * by}`;
  };
  return `M${cut(p, hasStartArrow)}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${cut(q, hasEndArrow)}`;
}
