import { memo } from '@teact';

import buildClassName from '../../util/buildClassName';

import styles from './ParvaneIcon.module.scss';

// Parvane: линейные значки оболочки (боковая панель, нижняя панель, шапка чатов, профиль) — контуры
// одной толщины цветом текста, как в прототипе дизайна. Значки мессенджера остаются шрифтом `Icon`
const PATHS = {
  chat: ['M4 5h16v11H9l-5 4z'],
  chats: ['M3 5h13v9H8l-5 4z', 'M8 17h8l5 4V9h-2'],
  sun: [
    'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
    'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  // «Здоровье» (spec 041): сон
  moon: ['M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z'],
  calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M3 10h18M8 3v4M16 3v4'],
  heart: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.3 1.5A3.3 3.3 0 0 0 7 18z'],
  search: ['M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12z', 'M20 20l-4.5-4.5'],
  user: ['M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M4 21a8 8 0 0 1 16 0'],
  users: [
    'M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
    'M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6',
  ],
  megaphone: ['M4 10v4h3l8 4V6L7 10z', 'M18 9a4 4 0 0 1 0 6'],
  plus: ['M12 5v14M5 12h14'],
  pen: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  right: ['M9 5l7 7-7 7'],
  check: ['M5 12l5 5 9-10'],
  sliders: [
    'M4 7h10M18 7h2M4 17h4M12 17h8',
    'M16 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
    'M10 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  ],
  warn: ['M12 3l10 18H2z', 'M12 10v5M12 18v.5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6M12 7.5v.01'],
  link: [
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  ],
  smile: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.5M15 9.5v.5'],
  // Значки папок чатов
  work: ['M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z', 'M9 7V5h6v2M3 13h18'],
  cap: ['M2 9l10-5 10 5-10 5z', 'M6 11v5c3 2 9 2 12 0v-5M22 9v6'],
  home: ['M3 11l9-7 9 7', 'M5 10v10h5v-6h4v6h5V10'],
  folder: ['M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  note: ['M6 3h9l4 4v14H6z', 'M14 3v5h5'],
  logout: ['M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4', 'M10 8l-4 4 4 4M6 12h10'],
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
  music: ['M9 18V5l11-2v13', 'M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6z', 'M17 13a3 3 0 1 0 0 6a3 3 0 1 0 0-6z'],
  left: ['M15 5l-7 7 7 7'],
  play: ['M7 5l12 7-12 7z'],
  pause: ['M8 5v14M16 5v14'],
  next: ['M5 5l10 7-10 7z', 'M19 5v14'],
  previous: ['M19 5L9 12l10 7z', 'M5 5v14'],
  shuffle: ['M3 7h4l10 10h4', 'M3 17h4l3-3', 'M14 10l3-3h4', 'M18 4l3 3-3 3', 'M18 14l3 3-3 3'],
  repeat: ['M4 12V9a3 3 0 0 1 3-3h11', 'M15 3l3 3-3 3', 'M20 12v3a3 3 0 0 1-3 3H6', 'M9 21l-3-3 3-3'],
  close: ['M6 6l12 12M18 6L6 18'],
  list: ['M4 7h16M4 12h16M4 17h16'],
  disc: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z'],
  upload: ['M12 16V4M7 9l5-5 5 5', 'M4 20h16'],
  download: ['M12 4v11M7 11l5 5 5-5', 'M5 20h14'],
  downloaded: ['M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18z', 'M12 7v8M8.5 12l3.5 3.5 3.5-3.5'],
  grip: ['M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01'],
  // «Музыка» (spec 041): исполнитель, «Отправить в чат», «Ещё» вертикальными точками
  mic: ['M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z', 'M6 11a6 6 0 0 0 12 0M12 17v4'],
  send: ['M4 12l16-7-6 16-3-7z'],
  more: ['M12 6h.01M12 12h.01M12 18h.01'],
  // Отпечаток пальца — клетка цифровой клавиатуры PIN (доска `ZpSystem`)
  fingerprint: [
    'M7 6.5A7 7 0 0 1 19 11v2', 'M5 10a7 7 0 0 1 1-3', 'M9 20a12 12 0 0 1-1-7a4 4 0 0 1 8 0v1',
    'M12 13v2a9 9 0 0 0 2 6', 'M16 18a14 14 0 0 0 .5-3', 'M5 14v-1',
  ],
  // «Музыка» (макет 23 ноя): состояния трека и действия
  heartPlus: ['M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z', 'M12 9v5M9.5 11.5h5'],
  cloudAdd: ['M8 18H7a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9a4 4 0 0 1 0 9h-2', 'M12 12v7M8.5 15.5h7'],
  cloudDown: ['M8 17H7a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9a4 4 0 0 1 0 8h-1', 'M12 12v8M9 17l3 3 3-3'],
  cloudLine: ['M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z'],
  preview: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M10 9l5 3-5 3z'],
  offline: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v8M8.5 12l3.5 3.5 3.5-3.5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  refresh: ['M20 11a8 8 0 0 0-14.9-3M4 4v4h4', 'M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4'],
  wave: ['M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4'],
  filter: ['M4 5h16l-6 8v6l-4-2v-4z'],
  sort: ['M4 7h10M4 12h7M4 17h4M18 5v14M15 16l3 3 3-3'],
  grid: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  merge: ['M6 4v5c0 3 6 3 6 6v5M18 4v5c0 3-6 3-6 6'],
  swap: ['M4 7h13M13 3l4 4-4 4', 'M20 17H7M11 13l-4 4 4 4'],
  ban: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M5.6 5.6l12.8 12.8'],
  copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
  trash: ['M4 7h16M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  share: ['M12 3v12M7 8l5-5 5 5', 'M5 14v6h14v-6'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
  ],
  server: ['M4 4h16v6H4zM4 14h16v6H4z', 'M8 7h.01M8 17h.01'],
  volume: ['M4 9h4l5-4v14l-5-4H4z', 'M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4'],
  chevronDown: ['M5 9l7 7 7-7'],
  chevronUp: ['M5 15l7-7 7 7'],
} satisfies Record<string, string[]>;

export type ParvaneIconName = keyof typeof PATHS;

type OwnProps = {
  name: ParvaneIconName;
  // Мелкий значок — 18 px (в плитках строк и кнопках-пилюлях), обычный — 22 px
  isSmall?: boolean;
  className?: string;
};

const ParvaneIcon = ({ name, isSmall, className }: OwnProps) => {
  return (
    <svg
      className={buildClassName(styles.root, isSmall && styles.small, className)}
      viewBox="0 0 24 24"
      aria-hidden
    >
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
};

export default memo(ParvaneIcon);
