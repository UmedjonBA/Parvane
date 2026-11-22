import type { AnimationLevel } from '../types';

import { ANIMATION_LEVEL_MED, ANIMATION_LEVEL_MIN } from '../config.ts';
import { IS_ANDROID, IS_IOS } from './browser/windowEnvironment.ts';

export function resolveTransitionName(
  name: 'slideOptimized' | 'slide' | 'layers',
  animationLevel: AnimationLevel,
  isDisabled = false,
) {
  if (isDisabled || animationLevel === ANIMATION_LEVEL_MIN) return 'none';

  if (animationLevel === ANIMATION_LEVEL_MED) return 'slideFade';

  return name === 'slideOptimized' ? 'slideOptimized' : name === 'slide' ? 'slide' : (
    IS_ANDROID ? 'slideFade' : IS_IOS ? 'slideLayers' : 'pushSlide'
  );
}
