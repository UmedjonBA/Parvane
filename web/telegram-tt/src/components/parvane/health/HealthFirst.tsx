import { memo } from '../../../lib/teact/teact';

import type { HealthBlockId } from '../../../util/parvaneModules';

import buildClassName from '../../../util/buildClassName';
import { HEALTH_BLOCK_IDS, setHealthBlockOn } from '../../../util/parvaneModules';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSwitch from '../notes/PvSwitch';
import HealthQuickInput from './HealthQuickInput';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  blocks: HealthBlockId[];
  // Компьютер: «Как понято» и «Ещё примеры» под полем (доска `ZdHealthX`)
  isWide?: boolean;
  // Заготовка строки первой записи (пример, кнопка «+»)
  request?: { text?: string };
  onExample: (text: string) => void;
  onRequestHandled: NoneToVoidFunction;
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

// Parvane (spec 041, доски `ZpHealthX`, `ZdHealthX`): первое открытие вместо сводки — как пользоваться строкой
// ввода, примеры, поле первой записи с показом разбора и «Что считать» выключателями (компьютер — две колонки).
// Блоки — настройка устройства, та же, что в «Профиль → Модули»
const HealthFirst = ({
  blocks, isWide, request, onExample, onRequestHandled, onDone,
}: OwnProps) => {
  const lang = useLang();

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onExample(e.currentTarget.textContent || '');
  });

  const handleBlock = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    setHealthBlockOn(e.currentTarget.dataset.block as HealthBlockId, isOn);
  });

  function renderExamples(keys: readonly typeof EXAMPLE_KEYS[number][]) {
    return (
      <>
        <div className={kit.caps}>{lang(isWide ? 'HealthFirstMore' : 'HealthFirstTry')}</div>
        <div className={styles.examples}>
          {keys.map((key) => (
            <button key={key} type="button" className={kit.chip} onClick={handleExample}>{lang(key)}</button>
          ))}
        </div>
      </>
    );
  }

  return (
    <section className={styles.first} data-health-first>
      <div className={styles.firstColumn}>
        <div>{lang('HealthFirstText')}</div>
        {!isWide && renderExamples(EXAMPLE_KEYS)}
        <label className={styles.firstLabel}>{lang('HealthFirstEntry')}</label>
        <HealthQuickInput
          request={request}
          placeholder={lang('HealthFirstPlaceholder')}
          isFirst={isWide}
          onRequestHandled={onRequestHandled}
        />
        {isWide && renderExamples(EXAMPLE_KEYS.filter((key) => key !== 'HealthExampleSleep'))}
      </div>
      <div className={styles.firstColumn}>
        <div className={kit.caps}>{lang('HealthFirstBlocks')}</div>
        <div className={buildClassName(kit.card, styles.firstBlocks)}>
          {HEALTH_BLOCK_IDS.map((block) => (
            <PvSwitch
              key={block}
              isOn={blocks.includes(block)}
              className={styles.firstBlock}
              data-block={block}
              onChange={handleBlock}
            >
              <span className={kit.grow}>{lang(BLOCK_TITLE_KEYS[block])}</span>
            </PvSwitch>
          ))}
        </div>
        <div className={buildClassName(kit.muted, kit.small)}>
          {lang(isWide ? 'HealthFirstBlocksHintWide' : 'HealthFirstBlocksHint')}
        </div>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
          data-health-first-done
          onClick={onDone}
        >
          {lang('HealthFirstDone')}
        </button>
      </div>
    </section>
  );
};

export default memo(HealthFirst);
