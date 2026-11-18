import { memo } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';

import styles from './Profile.module.scss';

// Parvane: значки «Профиля» с досок `PhoneProfile` и `DeskProfile` (штрих 1,8, поле 24)
const PATHS = {
  star: 'M12 4l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z',
  contacts: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 0 0 0-6M21 19c0-2.5-1.5-4-3.5-4.7',
  archive: 'M4 8h16v12H4zM3 4h18v4H3zM10 12h4',
  overview: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  modules: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  brush: 'M4 20c3 0 4-1.5 4-3.5L17 7l-3-3-9.5 9C2.5 15 3 18 4 20zM14 4l3 3',
  bell: 'M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  laptop: 'M5 5h14v10H5zM3 19h18',
  phone: 'M8 3h8v18H8zM11 18h2',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  key: 'M14 10a4 4 0 1 0-3.5 4L12 15.5h2v2h2v2h3v-3L13.8 11.3A4 4 0 0 0 14 10zM9 9h.01',
  disk: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  chat: 'M4 5h16v11H9l-5 4z',
  bug: 'M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.01',
  logout: 'M10 4H5v16h5M15 8l4 4-4 4M9 12h10',
  pen: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  right: 'M9 5l7 7-7 7',
  left: 'M15 5l-7 7 7 7',
} satisfies Record<string, string>;

export type ProfileIconName = keyof typeof PATHS;

type OwnProps = {
  name: ProfileIconName;
  isSmall?: boolean;
  className?: string;
};

const ProfileIcon = ({ name, isSmall, className }: OwnProps) => (
  <svg className={buildClassName(styles.icon, isSmall && styles.iconSmall, className)} viewBox="0 0 24 24" aria-hidden>
    <path d={PATHS[name]} />
  </svg>
);

export default memo(ProfileIcon);
