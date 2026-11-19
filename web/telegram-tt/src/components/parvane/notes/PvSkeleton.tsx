import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import useLoadStage from './useLoadStage';

import useLang from '../../../hooks/useLang';

import styles from './PvStates.module.scss';

type OwnProps = {
  className?: string;
  // Чем повторить загрузку: дольше десяти секунд подпись сменяется на «Нет ответа от сервера» и «Повторить»
  onRetry?: NoneToVoidFunction;
};

const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

// Загрузка списка макета (доски `ZpStates`, `ZdMisc`): заглушки стоят на месте будущих строк и не мигают;
// дольше трёх секунд — на месте заглушки заголовка появляется подпись «Загрузка…», дольше десяти —
// «Нет ответа от сервера» и «Повторить». Атрибуты `data-*` вызова переносятся на корень
const PvSkeleton = ({ className, onRetry, ...marks }: OwnProps) => {
  const lang = useLang();
  const { stage, retry } = useLoadStage(onRetry);

  function renderCaption() {
    if (stage === 'noAnswer') {
      return (
        <>
          <span role="alert">{lang('PvNoAnswer')}</span>
          <button type="button" className={styles.skeletonRetry} onClick={retry}>{lang('PvOfflineRetry')}</button>
        </>
      );
    }
    if (stage === 'slow') return <span role="status">{lang('ParvaneLoading')}</span>;
    return <span className={styles.skeletonHead} aria-hidden="true" />;
  }

  return (
    <div
      className={buildClassName(styles.skeleton, className)}
      aria-busy="true"
      data-no-answer={stage === 'noAnswer' || undefined}
      {...marks}
    >
      <div className={styles.skeletonCaption}>{renderCaption()}</div>
      {ROWS.map((row) => (
        <div key={row} className={styles.skeletonRow} aria-hidden="true">
          <span className={styles.skeletonIcon} />
          <span className={styles.skeletonText}>
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonSub} />
          </span>
          <span className={styles.skeletonWide} />
          <span className={styles.skeletonMeta} />
        </div>
      ))}
    </div>
  );
};

export default memo(PvSkeleton);
