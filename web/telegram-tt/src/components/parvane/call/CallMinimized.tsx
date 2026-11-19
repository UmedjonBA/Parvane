import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useOldLang from '../../../hooks/useOldLang';

import styles from './Call.module.scss';

type OwnProps = {
  name: string;
  time: string;
  onExpand: NoneToVoidFunction;
};

const CallMinimized = ({ name, time, onExpand }: OwnProps) => {
  const lang = useOldLang();
  return (
    <button
      type="button"
      className={styles.minimized}
      data-call-minimized
      aria-label={lang('ParvaneCallReturnTo', [name, time])}
      onClick={onExpand}
    >
      <i className={buildClassName('icon icon-phone', styles.minimizedIcon)} aria-hidden />
      <span className={styles.minimizedIdentity}>
        <span className={styles.minimizedName}>{name}</span>
        <span aria-hidden>·</span>
        <span className={styles.minimizedTime} data-call-elapsed>{time}</span>
      </span>
      <span className={styles.minimizedReturn}>{lang('ParvaneCallReturn')}</span>
      <i className={buildClassName('icon icon-next', styles.minimizedIcon)} aria-hidden />
    </button>
  );
};

export default memo(CallMinimized);
