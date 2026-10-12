// Поле графа и холста: вид (сдвиг и масштаб), масштаб вокруг точки, щипок двумя пальцами, вписывание

export type BoardView = { scale: number; x: number; y: number };
export type BoardRect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type PinchStart = { distance: number; view: BoardView; center: Point };

export const BOARD_MIN_SCALE = 0.15;
export const BOARD_MAX_SCALE = 2.5;
export const BOARD_ZOOM_STEP = 1.25;
export const BOARD_FIT_MAX_SCALE = 1.2;
// Клетка точечного фона при масштабе 1
export const BOARD_GRID = 22;
const WHEEL_RATE = 0.0015;
const MIN_PINCH_DISTANCE = 4;

export function clampBoardScale(scale: number) {
  return Math.min(BOARD_MAX_SCALE, Math.max(BOARD_MIN_SCALE, scale));
}

/** Тот же вид в другом масштабе: точка `(cx, cy)` поля остаётся на месте. */
export function zoomAround(view: BoardView, scale: number, cx: number, cy: number): BoardView {
  const next = clampBoardScale(scale);
  const k = next / view.scale;
  return { scale: next, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

export function zoomByWheel(view: BoardView, deltaY: number, cx: number, cy: number) {
  return zoomAround(view, view.scale * Math.exp(-deltaY * WHEEL_RATE), cx, cy);
}

/** Вид, в котором прямоугольники целиком видны под панелью инструментов (`top`) и над низом (`bottom`). */
export function fitRects(
  rects: BoardRect[], width: number, height: number, top: number, bottom: number, side = 20,
): BoardView {
  if (!rects.length || !width || !height) return { scale: 1, x: width / 2, y: height / 2 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  const roomY = Math.max(1, height - top - bottom);
  const scale = clampBoardScale(Math.min(
    Math.max(1, width - side * 2) / Math.max(1, x1 - x0), roomY / Math.max(1, y1 - y0), BOARD_FIT_MAX_SCALE,
  ));
  return {
    scale,
    x: (width - (x1 - x0) * scale) / 2 - x0 * scale,
    y: top + (roomY - (y1 - y0) * scale) / 2 - y0 * scale,
  };
}

/**
 * Вид, в котором видны и прямоугольники `rects`, и то, что было на экране. Если они уже целиком на поле (под
 * панелью `top`, над низом `bottom`) — прежний вид без изменений.
 */
export function revealRects(
  view: BoardView, rects: BoardRect[], width: number, height: number, top: number, bottom: number, side = 20,
): BoardView {
  if (!rects.length || !width || !height) return view;
  const shown = {
    x: (side - view.x) / view.scale,
    y: (top - view.y) / view.scale,
    width: Math.max(1, width - side * 2) / view.scale,
    height: Math.max(1, height - top - bottom) / view.scale,
  };
  const isShown = rects.every((rect) => (
    rect.x >= shown.x && rect.y >= shown.y
    && rect.x + rect.width <= shown.x + shown.width && rect.y + rect.height <= shown.y + shown.height
  ));
  return isShown ? view : fitRects([shown, ...rects], width, height, top, bottom, side);
}

/** Точечный фон, который едет и растёт вместе с полем. */
export function boardBackgroundStyle(view: BoardView) {
  const cell = BOARD_GRID * view.scale;
  return `background-position: ${view.x}px ${view.y}px; background-size: ${cell}px ${cell}px`;
}

/** Щипок: следит за пальцами на поле и отдаёт вид, пока их два. */
export function createPinch() {
  const points = new Map<number, Point>();
  let start: PinchStart | undefined;

  const pair = () => {
    const [a, b] = Array.from(points.values());
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  return {
    /** Палец коснулся поля. `true` — начался щипок, обычное перетаскивание надо прекратить. */
    down(pointerId: number, x: number, y: number, view: BoardView) {
      points.set(pointerId, { x, y });
      if (points.size !== 2) return false;
      const { distance, center } = pair();
      start = { distance: Math.max(MIN_PINCH_DISTANCE, distance), view, center };
      return true;
    },
    /** Палец сдвинулся. Вид — пока идёт щипок; `box` — положение поля в окне. */
    move(pointerId: number, x: number, y: number, box: { left: number; top: number }): BoardView | undefined {
      if (!points.has(pointerId)) return undefined;
      points.set(pointerId, { x, y });
      if (!start || points.size !== 2) return undefined;
      const { distance } = pair();
      return zoomAround(
        start.view,
        start.view.scale * (distance / start.distance),
        start.center.x - box.left,
        start.center.y - box.top,
      );
    },
    up(pointerId: number) {
      points.delete(pointerId);
      if (points.size < 2) start = undefined;
    },
    isActive() {
      return Boolean(start);
    },
  };
}
