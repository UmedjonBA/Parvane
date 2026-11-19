import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import useLoadStage from './useLoadStage';

import useLang from '../../../hooks/useLang';

import PvEmpty from './PvEmpty';
import PvGhost from './PvGhost';

import styles from './PvStates.module.scss';

type OwnProps = {
  className?: string;
  // Чем повторить загрузку: дольше десяти секунд вместо призрака — «Нет ответа от сервера» и «Повторить»
  onRetry?: NoneToVoidFunction;
};

// Загрузка макета (доска `PhStates`): вместо крутилки — призрак и подпись «Загрузка…».
// Атрибуты `data-*` вызова переносятся на корень
const PvLoading = ({ className, onRetry, ...marks }: OwnProps) => {
  const lang = useLang();
  const { stage, retry } = useLoadStage(onRetry);

  if (stage === 'noAnswer') {
    return (
      <PvEmpty
        className={className}
        title={lang('PvNoAnswer')}
        text={lang('PvNoAnswerText')}
        actionText={lang('PvOfflineRetry')}
        data-no-answer
        {...marks}
        onAction={retry}
      />
    );
  }

  return (
    <div className={buildClassName(styles.loading, className)} {...marks}>
      <PvGhost isLoading />
      <div role="status">{lang('ParvaneLoading')}</div>
    </div>
  );
};

export default memo(PvLoading);
