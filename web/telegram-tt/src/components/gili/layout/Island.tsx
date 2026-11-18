import type { ElementRef } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import styles from './Island.module.scss';

type OwnProps = React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
  ref?: ElementRef<HTMLDivElement>;
};

// Parvane: рядом с классами модуля стоят постоянные метки `pv-island*` — по ним экраны настроек красят
// острова по макету (`left/settings/profile/SettingsPv.scss`); в сборке имена классов модуля — хеши
const Island = ({ ref, className, children, ...otherProps }: OwnProps) => {
  return (
    <div
      ref={ref}
      className={buildClassName(styles.island, 'pv-island', className)}
      {...otherProps}
    >
      {children}
    </div>
  );
};

const IslandDescription = ({ className, children, ...otherProps }: OwnProps) => {
  return (
    <div
      className={buildClassName(styles.description, 'pv-island-description', className)}
      {...otherProps}
    >
      {children}
    </div>
  );
};

const IslandTitle = ({ className, children, ...otherProps }: OwnProps) => {
  return (
    <div
      className={buildClassName(styles.title, 'pv-island-title', className)}
      {...otherProps}
    >
      {children}
    </div>
  );
};

const IslandOutside = ({
  className,
  children,
  ...otherProps
}: OwnProps) => {
  return (
    <div
      className={buildClassName(
        styles.outside,
        className,
      )}
      {...otherProps}
    >
      {children}
    </div>
  );
};

const IslandText = ({ className, children, ...otherProps }: OwnProps) => {
  return (
    <div
      className={buildClassName(styles.text, className)}
      {...otherProps}
    >
      {children}
    </div>
  );
};

export default Island;
export {
  IslandOutside,
  IslandDescription,
  IslandTitle,
  IslandText,
};
