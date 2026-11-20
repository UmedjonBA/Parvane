import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import Modal from '../../ui/Modal';
import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './ChatScreen.module.scss';

type OwnProps = {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  // «Назад» стрелкой (чтение) либо «Закрыть» крестиком (форма, выбор)
  isBack?: boolean;
  // Текстовая кнопка справа в шапке («Отправить», «Готово»)
  actionLabel?: string;
  isActionDisabled?: boolean;
  headAfter?: TeactNode;
  className?: string;
  // Нижняя полоса, прижатая к краю экрана (кнопка отправки, подпись)
  footer?: TeactNode;
  children: React.ReactNode;
  onAction?: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
  onEnter?: NoneToVoidFunction;
};

// Экран чата по доскам `XpChat`, `RpPick`, `RpChat`: на телефоне — на весь экран, шапка 56 px с «Назад»/«Закрыть»,
// названием и подписью; на компьютере — то же окном по центру
const ChatScreen = ({
  isOpen, title, subtitle, isBack, actionLabel, isActionDisabled, headAfter, className, footer, children,
  onAction, onClose, onEnter,
}: OwnProps) => {
  const lang = useLang();

  const header = (
    <div className={styles.head}>
      <button
        type="button"
        className={kit.ib}
        aria-label={lang(isBack ? 'Back' : 'Close')}
        onClick={onClose}
      >
        <PvIcon name={isBack ? 'left' : 'x'} />
      </button>
      <div className={styles.headText}>
        <h2 className={styles.title} dir="auto">{title}</h2>
        {subtitle && <div className={styles.subtitle} dir="auto">{subtitle}</div>}
      </div>
      {headAfter}
      {actionLabel && (
        <button type="button" className={styles.action} disabled={isActionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      className={buildClassName(styles.screen, className)}
      header={header}
      onClose={onClose}
      onEnter={onEnter}
    >
      <div className={styles.body}>{children}</div>
      {Boolean(footer) && <div className={styles.footer}>{footer}</div>}
    </Modal>
  );
};

export default memo(ChatScreen);
