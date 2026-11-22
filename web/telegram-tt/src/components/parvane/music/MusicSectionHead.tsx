import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import ParvaneIcon from '../../main/ParvaneIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicSection.module.scss';

type OwnProps = {
  title: string;
  // Подпись над названием: «Мой плейлист», «Исполнитель»
  kicker?: string;
  // Строка под названием: «42 трека · 2 ч 38 мин»
  subtitle?: TeactNode;
  // Обложка слева (плейлист, альбом, исполнитель)
  cover?: TeactNode;
  // Кнопки справа на компьютере, под шапкой на телефоне: «Играть», «Вперемешку», «Изменить лимит»
  actions?: TeactNode;
  // Поле отбора и сортировка раздела (компьютер — в строке шапки)
  tools?: TeactNode;
  // Телефон: верхняя строка страницы — «назад», название страницы, значки справа
  barTitle?: string;
  // Вторая строка под названием страницы: «поиск» (доска `ZpMusicX`)
  barSubtitle?: string;
  barActions?: TeactNode;
  isPhone?: boolean;
  onBack?: NoneToVoidFunction;
};

// Parvane (spec 041, доски `DeskMusicMore`, `RdMusic`, `XdMusic`, `ZdMusicX`, `MusicPlaylist`, `RpMusicA`): шапка
// раздела «Музыки» — одна на все экраны: название и число, поле отбора, сортировка, «Слушать / Вперемешку».
// На телефоне сверху строка страницы с «назад»
const MusicSectionHead = ({
  title, kicker, subtitle, cover, actions, tools, barTitle, barSubtitle, barActions, isPhone, onBack,
}: OwnProps) => {
  const lang = useLang();
  // Телефон: название — в строке страницы; крупная шапка — только с обложкой (плейлист, альбом, исполнитель)
  const hasHero = !isPhone || Boolean(cover || kicker);

  return (
    <header className={styles.head} data-music-head>
      {isPhone && onBack && (
        <div className={styles.bar}>
          <button type="button" className={kit.ib} aria-label={lang('Back')} data-music-back onClick={onBack}>
            <ParvaneIcon name="left" />
          </button>
          <div className={styles.barTitles}>
            <h1 className={styles.barTitle}>{barTitle || title}</h1>
            {barSubtitle && <div className={styles.barSubtitle} data-music-bar-subtitle>{barSubtitle}</div>}
          </div>
          {barActions}
        </div>
      )}
      {hasHero && (
        <div className={buildClassName(styles.hero, cover && styles.heroWithCover)}>
          {cover}
          <div className={styles.heroText}>
            {kicker && <div className={buildClassName(kit.muted, kit.small)}>{kicker}</div>}
            <h2 className={styles.title} data-music-title>{title}</h2>
            {Boolean(subtitle) && (
              <div className={buildClassName(styles.subtitle, kit.mono, kit.muted)}>{subtitle}</div>
            )}
          </div>
          {!isPhone && tools}
          {!isPhone && Boolean(actions) && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {isPhone && Boolean(actions) && <div className={styles.actions}>{actions}</div>}
      {isPhone && Boolean(tools) && <div className={styles.tools}>{tools}</div>}
    </header>
  );
};

export default memo(MusicSectionHead);
