import { memo } from '../../../lib/teact/teact';

import type { HealthBlockId } from '../../../util/parvaneModules';

import buildClassName from '../../../util/buildClassName';
import { HEALTH_BLOCK_IDS } from '../../../util/parvaneModules';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  blocks: HealthBlockId[];
  // Левая колонка компьютера: «… выключены в «Профиль → Модули».» (доска `DeskHealthDetail`)
  isShort?: boolean;
  onOpenBlocks: NoneToVoidFunction;
};

const BLOCK_TITLE_KEYS = {
  sleep: 'ParvaneHealthBlockSleep',
  body: 'ParvaneHealthBlockBody',
  food: 'ParvaneHealthBlockFood',
  water: 'ParvaneHealthBlockWater',
  workouts: 'ParvaneHealthBlockWorkouts',
} as const;

// Parvane (spec 041; доски `Health`, `DeskHealthDetail`, `XpHealth`): какие блоки «Здоровья» выключены и где их
// включить; нажатие открывает «Профиль → Модули»
const HealthBlocksNote = ({ blocks, isShort, onOpenBlocks }: OwnProps) => {
  const lang = useLang();
  const off = HEALTH_BLOCK_IDS.filter((block) => !blocks.includes(block));
  if (!off.length) return undefined;

  const names = off.map((block, index) => {
    const title = lang(BLOCK_TITLE_KEYS[block]);
    return index ? title.toLowerCase() : title;
  });
  const list = lang.conjunction(names);
  const key = off.length === 1
    ? isShort ? 'HealthBlockOffShort' : 'HealthBlockOff'
    : isShort ? 'HealthBlocksOffShort' : 'HealthBlocksOff';

  return (
    <button
      type="button"
      className={buildClassName(kit.muted, kit.small, styles.blocksNote)}
      data-health-blocks-note={off.join(' ')}
      onClick={onOpenBlocks}
    >
      {lang(key, { blocks: list })}
    </button>
  );
};

export default memo(HealthBlocksNote);
