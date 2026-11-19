import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import styles from './Call.module.scss';

type OwnProps = {
  icon: string;
  label: string;
  kind?: 'plain' | 'on' | 'hangup' | 'accept';
  isLarge?: boolean;
  // Подпись под кнопкой (экран входящего звонка)
  caption?: string;
  onClick: NoneToVoidFunction;
};

// Круглая кнопка звонка (доски `PhCalls`, `RpCalls`, `DkCalls`)
const CallButton = ({
  icon, label, kind = 'plain', isLarge, caption, onClick,
}: OwnProps) => {
  const button = (
    <button
      type="button"
      className={buildClassName(styles.round, styles[kind], isLarge && styles.roundLarge)}
      aria-label={label}
      title={label}
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
