import type { FC } from '../../lib/teact/teact';
import { memo } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';
import renderText from './helpers/renderText';

import useOldLang from '../../hooks/useOldLang';
import useShowTransitionDeprecated from '../../hooks/useShowTransitionDeprecated';

import ParvaneMascot from '../ui/ParvaneMascot';

import './NothingFound.scss';

interface OwnProps {
  text?: string;
  description?: string;
  withSticker?: boolean;
  className?: string;
}

const DEFAULT_TEXT = 'Nothing found.';

const NothingFound: FC<OwnProps> = ({
  text = DEFAULT_TEXT, description, withSticker, className,
}) => {
  const lang = useOldLang();
  const { transitionClassNames } = useShowTransitionDeprecated(true);

  return (
    <div className={buildClassName(
      'NothingFound',
      className,
      transitionClassNames,
      description && 'with-description',
      withSticker && 'with-sticker')}
    >
      {/* Parvane: вместо утки Telegram — дух с лупой */}
      {withSticker && <ParvaneMascot variant="search" className="sticker" />}
      {text}
      {description && <p className="description">{renderText(lang(description), ['br'])}</p>}
    </div>
  );
};

export default memo(NothingFound);
