import buildClassName from '../../util/buildClassName';

import styles from './ParvaneMascot.module.scss';

type OwnProps = {
  // `search` — дух с лупой для «ничего не найдено»; без варианта — индикатор загрузки
  variant?: 'search';
  className?: string;
};

// Parvane: маскот — пиксельный дух. Листы кадров рисуют `web/dev/gen_mascot.mjs` (загрузка: вместо кружка,
// класс `Spinner` оставлен — на него смотрят стили и сценарии) и `web/dev/gen_mascot_search.mjs` (с лупой:
// это картинка, а не загрузка, поэтому без `Spinner` и `progressbar`)
const ParvaneMascot = ({ variant, className }: OwnProps) => {
  if (variant === 'search') {
    return <div className={buildClassName(styles.root, styles.search, className)} aria-hidden="true" />;
  }

  return <div className={buildClassName('Spinner', styles.root, className)} role="progressbar" aria-busy="true" />;
};

export default ParvaneMascot;
