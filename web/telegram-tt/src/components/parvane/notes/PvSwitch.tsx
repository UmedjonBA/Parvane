import type { TeactNode } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLastCallback from '../../../hooks/useLastCallback';

import styles from './PvSwitch.module.scss';

type OwnProps = {
  isOn: boolean;
  // Подпись для чтения с экрана, когда видимого текста нет
  label?: string;
  isDisabled?: boolean;
  className?: string;
  // Видимый текст: тогда выключатель — вся строка, дорожка стоит в её конце
  children?: TeactNode;
  onChange: (isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => void;
};

// Единый выключатель макета (`.sw` в `pv.css`, доска `ZpStates`): `role="switch"` и `aria-checked`, пробел и Enter —
// штатная кнопка. Атрибуты `data-*` вызова переносятся на кнопку — по ним выключатель находят сценарии
const PvSwitch = ({
  isOn, label, isDisabled, className, children, onChange, ...marks
}: OwnProps) => {
  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onChange(!isOn, e);
  });

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={label}
      disabled={isDisabled}
      className={buildClassName(styles.root, children !== undefined && styles.row, className)}
      {...marks}
      onClick={handleClick}
    >
      {children}
      <span className={buildClassName(styles.track, isOn && styles.trackOn)} aria-hidden />
    </button>
  );
};

export default PvSwitch;
