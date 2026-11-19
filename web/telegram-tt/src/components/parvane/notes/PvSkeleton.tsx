import { memo, useEffect, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import styles from './PvStates.module.scss';

type OwnProps = {
  className?: string;
};

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];
const SLOW_AFTER_MS = 3000;

// Загрузка списка макета (доски `ZpStates`, `ZdMisc`): заглушки стоят на месте будущих строк и не мигают;
// дольше трёх секунд — на месте заглушки заголовка появляется подпись «Загрузка…».
// Атрибуты `data-*` вызова переносятся на корень
const PvSkeleton = ({ className, ...marks }: OwnProps) => {
  const lang = useLang();
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={buildClassName(styles.skeleton, className)} aria-busy="true" {...marks}>
      <div className={styles.skeletonCaption}>
        {isSlow
          ? <span role="status">{lang('ParvaneLoading')}</span>
          : <span className={styles.skeletonHead} aria-hidden="true" />}
      </div>
      {ROWS.map((row) => (
        <div key={row} className={styles.skeletonRow} aria-hidden="true">
          <span className={styles.skeletonIcon} />
          <span className={styles.skeletonText}>
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonSub} />
          </span>
          <span className={styles.skeletonMeta} />
        </div>
      ))}
    </div>
  );
};

export default memo(PvSkeleton);
