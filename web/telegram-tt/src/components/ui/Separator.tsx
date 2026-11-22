import buildClassName from '../../util/buildClassName';

import styles from './Separator.module.scss';

type OwnProps = {
  children?: React.ReactNode;
  className?: string;
};

function Separator({ children, className }: OwnProps) {
  return (
    <div
      className={buildClassName(styles.separator, className)}
    >
      {children}
    </div>
  );
}

export default Separator;
