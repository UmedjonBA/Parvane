import { memo } from '../../../lib/teact/teact';

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
      <i className="icon icon-phone" aria-hidden />
      <span className={styles.minimizedName}>{name}</span>
      <span className={styles.minimizedTime}>
        {'· '}
        {time}
      </span>
      <span className={styles.minimizedReturn}>{lang('ParvaneCallReturn')}</span>
      <i className="icon icon-next" aria-hidden />
    </button>
  );
};

export default memo(CallMinimized);
