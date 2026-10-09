import { memo } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';

import ParvaneMascot from './ParvaneMascot';

import './Loading.scss';

type OwnProps = {
  color?: 'blue' | 'white' | 'black' | 'yellow';
  backgroundColor?: 'light' | 'dark';
  className?: string;
  onClick?: NoneToVoidFunction;
};

// Parvane: вместо кружка — маскот; `color` и `backgroundColor` оставлены для совместимости вызовов
const Loading = ({ className, onClick }: OwnProps) => {
  return (
    <div className={buildClassName('Loading', onClick && 'interactive', className)} onClick={onClick}>
      <ParvaneMascot />
    </div>
  );
};

export default memo(Loading);
