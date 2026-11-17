import { memo } from '../../../lib/teact/teact';

import type { HealthBlockId } from '../../../util/parvaneModules';

import buildClassName from '../../../util/buildClassName';
import { HEALTH_BLOCK_IDS, setHealthBlockOn } from '../../../util/parvaneModules';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  blocks: HealthBlockId[];
  onExample: (text: string) => void;
  onDone: NoneToVoidFunction;
};

const EXAMPLE_KEYS = [
  'HealthExampleWeight', 'HealthExampleSleep', 'HealthExamplePressure', 'HealthExamplePulse', 'HealthExampleSteps',
  'HealthExampleMood',
] as const;
const BLOCK_TITLE_KEYS = {
  sleep: 'ParvaneHealthBlockSleep',
  body: 'ParvaneHealthBlockBody',
  food: 'ParvaneHealthBlockFood',
  water: 'ParvaneHealthBlockWater',
  workouts: 'ParvaneHealthBlockWorkouts',
} as const;

// Parvane (spec 041, доски `ZpHealthX`, `ZdHealthX`): первое открытие — как пользоваться строкой ввода, примеры
// и выбор блоков. Блоки — настройка устройства, та же, что в «Профиль → Модули»
const HealthFirst = ({ blocks, onExample, onDone }: OwnProps) => {
  const lang = useLang();

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(e.currentTarget.textContent || '');
  });

  const handleBlock = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const block = e.currentTarget.dataset.block as HealthBlockId;
    setHealthBlockOn(block, !blocks.includes(block));
  });

  return (
    <section className={buildClassName(kit.card, styles.card)} data-health-first>
      <div>{lang('HealthFirstText')}</div>
      <div className={kit.caps}>{lang('HealthFirstTry')}</div>
      <div className={styles.examples}>
        {EXAMPLE_KEYS.map((key) => (
          <button key={key} type="button" className={kit.chip} onClick={handleExample}>{lang(key)}</button>
        ))}
      </div>
      <div className={kit.caps}>{lang('HealthFirstBlocks')}</div>
      <div className={styles.examples}>
        {HEALTH_BLOCK_IDS.map((block) => (
          <button
            key={block}
            type="button"
            role="switch"
            aria-checked={blocks.includes(block)}
            className={buildClassName(kit.chip, blocks.includes(block) && kit.chipOn)}
            data-block={block}
            onClick={handleBlock}
          >
            {lang(BLOCK_TITLE_KEYS[block])}
          </button>
        ))}
      </div>
      <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthFirstBlocksHint')}</div>
      <div className={styles.cardButtons}>
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} data-health-first-done onClick={onDone}>
          {lang('HealthFirstDone')}
        </button>
      </div>
    </section>
  );
};

export default memo(HealthFirst);
