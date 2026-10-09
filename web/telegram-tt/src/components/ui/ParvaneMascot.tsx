import buildClassName from '../../util/buildClassName';

import styles from './ParvaneMascot.module.scss';

type OwnProps = {
  className?: string;
};

// Parvane: маскот — пиксельный дух, индикатор загрузки вместо кружка. Лист кадров рисует
// `web/dev/gen_mascot.mjs`. Класс `Spinner` оставлен: на него смотрят стили и сценарии
const ParvaneMascot = ({ className }: OwnProps) => {
  return <div className={buildClassName('Spinner', styles.root, className)} role="progressbar" aria-busy="true" />;
};

export default ParvaneMascot;
