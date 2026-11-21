import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import styles from './Call.module.scss';

type OwnProps = {
  icon: string;
  label: string;
  kind?: 'plain' | 'on' | 'hangup' | 'accept';
  isLarge?: boolean;
  // Недоступно в этом браузере: кнопка видна, но не нажимается; причина — в `hint`
  isDisabled?: boolean;
  hint?: string;
  // Подпись под кнопкой (экран входящего звонка)
  caption?: string;
  onClick: NoneToVoidFunction;
};

// Круглая кнопка звонка (доски `PhCalls`, `RpCalls`, `DkCalls`)
const CallButton = ({
  icon, label, kind = 'plain', isLarge, isDisabled, hint, caption, onClick,
}: OwnProps) => {
  const button = (
    <button
      type="button"
      className={buildClassName(styles.round, styles[kind], isLarge && styles.roundLarge)}
      aria-label={label}
      title={hint || label}
      disabled={isDisabled}
      onClick={onClick}
    >
      <i className={buildClassName('icon', icon)} aria-hidden />
    </button>
  );
  if (!caption) return button;
  return (
    <div className={styles.captioned}>
      {button}
      <span aria-hidden>{caption}</span>
    </div>
  );
};

export default memo(CallButton);
