import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import PvGhost from './PvGhost';

import kit from './PvKit.module.scss';
import styles from './PvStates.module.scss';

type OwnProps = {
  title?: string;
  text?: string;
  className?: string;
  // Основная кнопка и ссылка под ней
  actionText?: string;
  linkText?: string;
  children?: TeactNode;
  onAction?: NoneToVoidFunction;
  onLink?: NoneToVoidFunction;
};

// Состояние «пусто» макета (доски `PhStates`, `RpMusicB`): призрак, заголовок, пояснение, основная кнопка,
// ссылка. Атрибуты `data-*` вызова переносятся на корень — по ним экран находят сценарии
const PvEmpty = ({
  title, text, className, actionText, linkText, children, onAction, onLink, ...marks
}: OwnProps) => (
  <div className={buildClassName(styles.empty, className)} {...marks}>
    <PvGhost />
    {title && <h2 className={styles.emptyTitle}>{title}</h2>}
    {text && <p className={styles.emptyText}>{text}</p>}
    {actionText && (
      <button type="button" className={buildClassName(kit.btn, kit.btnAcc, styles.emptyAction)} onClick={onAction}>
        {actionText}
      </button>
    )}
    {linkText && (
      <button type="button" className={buildClassName(kit.plain, styles.emptyLink)} onClick={onLink}>
        {linkText}
      </button>
    )}
    {children}
  </div>
);

export default memo(PvEmpty);
