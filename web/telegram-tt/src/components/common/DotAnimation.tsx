import { memo } from '@teact';

import buildClassName from '../../util/buildClassName';
import renderText from './helpers/renderText';

import './DotAnimation.scss';

type OwnProps = {
  content: string;
  className?: string;
};

const DotAnimation = ({ content, className }: OwnProps) => {
  return (
    <span className={buildClassName('DotAnimation', className)} dir="auto">
      {renderText(content)}
      <span className="ellipsis" />
    </span>
  );
};

export default memo(DotAnimation);
