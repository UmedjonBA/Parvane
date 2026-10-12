import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import kit from './PvKit.module.scss';

// Фигура значка: линия (`d`), круг (`c`: центр и радиус) либо прямоугольник (`r`: x, y, ширина, высота, скругление)
type Shape =
  | { d: string }
  | { c: [number, number, number]; isFilled?: boolean }
  | { r: [number, number, number, number, number]; isDashed?: boolean };

// Линейные значки прототипа: поле 24×24, обводка 1,8
const ICONS = {
  plus: [{ d: 'M12 5v14M5 12h14' }],
  minus: [{ d: 'M5 12h14' }],
  search: [{ c: [11, 11, 6] }, { d: 'M20 20l-4.5-4.5' }],
  left: [{ d: 'M15 5l-7 7 7 7' }],
  right: [{ d: 'M9 5l7 7-7 7' }],
  up: [{ d: 'M6 15l6-6 6 6' }],
  down: [{ d: 'M6 9l6 6 6-6' }],
  x: [{ d: 'M6 6l12 12M18 6L6 18' }],
  check: [{ d: 'M5 12l5 5 9-10' }],
  edit: [{ d: 'M4 20h4L19 9l-4-4L4 16z' }],
  trash: [{ d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }],
  cal: [{ r: [3, 5, 18, 16, 2] }, { d: 'M3 10h18M8 3v4M16 3v4' }],
  sun: [
    { c: [12, 12, 4] },
    { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' },
  ],
  note: [{ d: 'M6 3h9l4 4v14H6z' }, { d: 'M14 3v5h5' }],
  link: [{
    d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  }],
  text: [{ d: 'M5 6h14M12 6v13' }],
  group: [{ r: [3, 5, 18, 15, 3], isDashed: true }, { d: 'M3 9h7' }],
  board: [
    { r: [3, 3, 8, 7, 1.5] }, { r: [14, 6, 7, 6, 1.5] }, { r: [6, 15, 8, 6, 1.5] }, { d: 'M11 7h3M10 10l0 5' },
  ],
  fit: [{ d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }],
  graph: [
    { c: [6, 6, 2.5] }, { c: [18, 9, 2.5] }, { c: [9, 18, 2.5] },
    { d: 'M8.4 6.6l7.2 1.8M6.6 8.4l1.8 7.2M16.2 10.8l-5.4 5.4' },
  ],
  folder: [{ d: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  move: [
    { d: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
    { d: 'M10 13h6M13 10l3 3-3 3' },
  ],
  image: [{ r: [3, 4, 18, 16, 2] }, { c: [9, 10, 2] }, { d: 'M21 16l-5-5-8 9' }],
  upload: [{ d: 'M12 16V4M7 9l5-5 5 5M4 20h16' }],
  download: [{ d: 'M12 4v11M7 10l5 5 5-5M5 20h14' }],
  users: [{ c: [9, 8, 3.5] }, { d: 'M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6' }],
  dots: [
    { c: [12, 5, 1.4], isFilled: true }, { c: [12, 12, 1.4], isFilled: true }, { c: [12, 19, 1.4], isFilled: true },
  ],
  eye: [{ d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z' }, { c: [12, 12, 3] }],
  chat: [{ d: 'M4 5h16v11H9l-5 4z' }],
  restore: [{ d: 'M4 12a8 8 0 1 0 2.4-5.7' }, { d: 'M4 4v4h4' }],
  cloud: [{ d: 'M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.3 1.5A3.3 3.3 0 0 0 7 18z' }],
  lock: [{ r: [5, 11, 14, 9, 2] }, { d: 'M8 11V8a4 4 0 0 1 8 0v3' }],
  undo: [{ d: 'M9 14L4 9l5-5' }, { d: 'M4 9h10a6 6 0 0 1 0 12h-3' }],
  redo: [{ d: 'M15 14l5-5-5-5' }, { d: 'M20 9H10a6 6 0 0 0 0 12h3' }],
  copy: [{ r: [8, 8, 12, 12, 2] }, { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }],
  select: [{ r: [3, 3, 14, 14, 2], isDashed: true }, { d: 'M13 13l8 3-3.5 1.5L16 21z' }],
  arrow: [{ d: 'M4 12h16M14 6l6 6-6 6' }],
  open: [{ d: 'M14 4h6v6M20 4l-9 9' }, { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }],
  file: [{ d: 'M6 3h9l4 4v14H6z' }, { d: 'M14 3v5h5M9 13h6M9 17h6' }],
  front: [{ r: [9, 9, 12, 12, 2] }, { d: 'M5 15V5h10' }],
  back: [{ r: [3, 3, 12, 12, 2] }, { d: 'M19 9v10H9' }],
  alignLeft: [{ d: 'M4 3v18' }, { r: [7, 6, 12, 4, 1] }, { r: [7, 14, 7, 4, 1] }],
  alignCenter: [{ d: 'M12 3v18' }, { r: [5, 6, 14, 4, 1] }, { r: [8, 14, 8, 4, 1] }],
  alignRight: [{ d: 'M20 3v18' }, { r: [5, 6, 12, 4, 1] }, { r: [10, 14, 7, 4, 1] }],
  alignTop: [{ d: 'M3 4h18' }, { r: [6, 7, 4, 12, 1] }, { r: [14, 7, 4, 7, 1] }],
  alignMiddle: [{ d: 'M3 12h18' }, { r: [6, 5, 4, 14, 1] }, { r: [14, 8, 4, 8, 1] }],
  alignBottom: [{ d: 'M3 20h18' }, { r: [6, 5, 4, 12, 1] }, { r: [14, 10, 4, 7, 1] }],
  spreadX: [{ d: 'M4 3v18M20 3v18' }, { r: [9, 7, 6, 10, 1] }],
  spreadY: [{ d: 'M3 4h18M3 20h18' }, { r: [7, 9, 10, 6, 1] }],
  paste: [{ r: [5, 5, 14, 16, 2] }, { d: 'M9 5V3h6v2M9 11h6M9 15h6' }],
} satisfies Record<string, Shape[]>;

export type PvIconName = keyof typeof ICONS;

type OwnProps = {
  name: PvIconName;
  isSmall?: boolean;
  className?: string;
};

const PvIcon = ({ name, isSmall, className }: OwnProps) => {
  const shapes: Shape[] = ICONS[name];
  return (
    <svg className={buildClassName(kit.icon, isSmall && kit.iconS, className)} viewBox="0 0 24 24" aria-hidden="true">
      {shapes.map((shape, i) => {
        const key = `${name}${i}`;
        if ('d' in shape) return <path key={key} d={shape.d} />;
        if ('c' in shape) {
          return (
            <circle
              key={key}
              className={shape.isFilled ? kit.iconDot : undefined}
              cx={shape.c[0]}
              cy={shape.c[1]}
              r={shape.c[2]}
            />
          );
        }
        return (
          <rect
            key={key}
            className={shape.isDashed ? kit.iconDashed : undefined}
            x={shape.r[0]}
            y={shape.r[1]}
            width={shape.r[2]}
            height={shape.r[3]}
            rx={shape.r[4]}
          />
        );
      })}
    </svg>
  );
};

export default memo(PvIcon);
