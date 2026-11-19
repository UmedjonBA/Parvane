import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import PvGhost from './PvGhost';

import styles from './PvStates.module.scss';

type OwnProps = {
  className?: string;
};

// Загрузка макета (доска `PhStates`): вместо крутилки — призрак и подпись «Загрузка…».
// Атрибуты `data-*` вызова переносятся на корень
const PvLoading = ({ className, ...marks }: OwnProps) => {
  const lang = useLang();

  return (
    <div className={buildClassName(styles.loading, className)} {...marks}>
      <PvGhost isLoading />
      <div role="status">{lang('ParvaneLoading')}</div>
    </div>
  );
};

export default memo(PvLoading);
