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
