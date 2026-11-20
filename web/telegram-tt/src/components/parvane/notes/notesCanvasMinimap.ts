// Parvane, «Заметки»: мини-карта холста — рамка, в которую вписаны все карточки и видимая часть поля, и перевод
// нажатия на мини-карте в новый вид поля (видимая часть встаёт серединой в точку нажатия)

import type { BoardView } from './boardView';
import type { CanvasRect } from './notesCanvas';

import { boundsOfRects } from './notesCanvas';

export type MinimapFrame = { box: CanvasRect; visible: CanvasRect };

const FRAME_PADDING = 40;

export function visibleRect(view: BoardView, width: number, height: number): CanvasRect {
  return {
    x: -view.x / view.scale, y: -view.y / view.scale, width: width / view.scale, height: height / view.scale,
  };
}

export function minimapFrame(rects: CanvasRect[], view: BoardView, width: number, height: number): MinimapFrame {
  const visible = visibleRect(view, width, height);
  const all = boundsOfRects([...rects, visible])!;
  return {
    box: {
      x: all.x - FRAME_PADDING,
      y: all.y - FRAME_PADDING,
      width: all.width + FRAME_PADDING * 2,
      height: all.height + FRAME_PADDING * 2,
    },
    visible,
  };
}

// `fx`, `fy` — доли ширины и высоты мини-карты; рамка показана с `preserveAspectRatio="xMidYMid meet"`, поэтому
// пустые поля по краям учитываются отношением сторон мини-карты `aspect` (ширина / высота)
export function viewFromMinimap(
  frame: MinimapFrame, fx: number, fy: number, aspect: number, view: BoardView, width: number, height: number,
): BoardView {
  const { box } = frame;
  const scale = Math.max(box.width / aspect, box.height);
  const shownWidth = scale * aspect;
  const x = box.x - (shownWidth - box.width) / 2 + fx * shownWidth;
  const y = box.y - (scale - box.height) / 2 + fy * scale;
  return { scale: view.scale, x: width / 2 - x * view.scale, y: height / 2 - y * view.scale };
}
