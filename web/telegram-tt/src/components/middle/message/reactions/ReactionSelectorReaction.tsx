import { memo } from '../../../../lib/teact/teact';

import type { ApiAvailableReaction, ApiReaction } from '../../../../api/types';

import buildClassName from '../../../../util/buildClassName';
import { REM } from '../../../common/helpers/mediaDimensions';

import useFlag from '../../../../hooks/useFlag';
import useMedia from '../../../../hooks/useMedia';

import AnimatedSticker from '../../../common/AnimatedSticker';
import Icon from '../../../common/icons/Icon';

import styles from './ReactionSelectorReaction.module.scss';

const REACTION_SIZE = 2 * REM;

type OwnProps = {
  reaction: ApiAvailableReaction;
  isReady?: boolean;
  chosen?: boolean;
  noAppearAnimation?: boolean;
  isLocked?: boolean;
  onToggleReaction: (reaction: ApiReaction) => void;
};

const ReactionSelectorReaction = ({
  reaction,
  isReady,
  noAppearAnimation,
  chosen,
  isLocked,
  onToggleReaction,
}: OwnProps) => {
  const appearAnimationHash = reaction.appearAnimation?.id ? `sticker${reaction.appearAnimation.id}` : false;
  const selectAnimationHash = reaction.selectAnimation?.id ? `document${reaction.selectAnimation.id}` : false;
  const staticIconHash = reaction.staticIcon?.id ? `document${reaction.staticIcon.id}` : false;
  const mediaAppearData = useMedia(appearAnimationHash, !isReady || noAppearAnimation);
  const mediaData = useMedia(selectAnimationHash, !isReady || noAppearAnimation);
  const staticIconData = useMedia(staticIconHash, !noAppearAnimation);
  const [isAnimationLoaded, markAnimationLoaded] = useFlag();

  const [isFirstPlay, , unmarkIsFirstPlay] = useFlag(true);
  const [isActivated, activate, deactivate] = useFlag();
  const hasStaticIcon = Boolean(reaction.staticIcon);
  const hasAnimations = Boolean(reaction.appearAnimation && reaction.selectAnimation);
  const shouldRenderFallback = !hasStaticIcon && !hasAnimations;

  function handleClick() {
    onToggleReaction(reaction.reaction);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleClick();
  }

  return (
    <div
      className={buildClassName(styles.root, chosen && styles.chosen)}
      role="button"
      tabIndex={0}
      aria-label={reaction.reaction.emoticon}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={isReady && !isFirstPlay ? activate : undefined}
    >
      {shouldRenderFallback && (
        <span className={styles.fallbackEmoji}>{reaction.reaction.emoticon}</span>
      )}
      {!shouldRenderFallback && noAppearAnimation && (
        <img
          className={styles.staticIcon}
          src={staticIconData}
          alt={reaction.reaction.emoticon}
          draggable={false}
        />
      )}
      {hasAnimations && !isAnimationLoaded && !noAppearAnimation && (
        <AnimatedSticker
          key={reaction.appearAnimation?.id}
          tgsUrl={mediaAppearData}
          play={isFirstPlay}
          noLoop
          size={REACTION_SIZE}
          onEnded={unmarkIsFirstPlay}
          forceAlways
        />
      )}
      {hasAnimations && !isFirstPlay && !noAppearAnimation && (
        <AnimatedSticker
          key={reaction.selectAnimation?.id}
          tgsUrl={mediaData}
          play={isActivated}
          noLoop
          size={REACTION_SIZE}
          onLoad={markAnimationLoaded}
          onEnded={deactivate}
          forceAlways
        />
      )}
      {isLocked && (
        <Icon className={styles.lock} name="lock-badge" />
      )}
    </div>
  );
};

export default memo(ReactionSelectorReaction);
