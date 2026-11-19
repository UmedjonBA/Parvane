import buildClassName from '../../../util/buildClassName';

import styles from './PvStates.module.scss';

type OwnProps = {
  // Загрузка: призрак цвета акцента, подпрыгивает (при выключенных анимациях неподвижен)
  isLoading?: boolean;
};

// Пиксельный призрак макета (доска `PhStates`): поле 12×12, глаза — прорези
const GHOST_PATH = 'M3 1h6v1h1v1h1v8h-2v-1h-1v1H7v-1H5v1H4v-1H3v1H1V3h1V2h1zM4 4v2h1V4zM7 4v2h1V4z';

const PvGhost = ({ isLoading }: OwnProps) => (
  <svg
    className={buildClassName(styles.ghost, isLoading && styles.ghostLoading)}
    viewBox="0 0 12 12"
    aria-hidden="true"
  >
    <path d={GHOST_PATH} fill-rule="evenodd" />
  </svg>
);

export default PvGhost;
