import { memo } from '../../../lib/teact/teact';

import type { PlannerLayer, PlannerLayers } from './plannerLayers';

import buildClassName from '../../../util/buildClassName';
import { PLANNER_LAYERS } from './plannerLayers';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  layers: PlannerLayers;
  onToggle: (layer: PlannerLayer) => void;
};

const LAYER_LABELS = {
  sleep: 'PlannerHealthSleep',
  food: 'PlannerHealthFood',
  work: 'PlannerLayerWork',
} as const satisfies Record<PlannerLayer, string>;
const LAYER_KINDS = {
  sleep: styles.kindSleep,
  food: styles.kindFood,
  work: styles.kindEvent,
} satisfies Record<PlannerLayer, string>;

// Слои календаря: сон, еда, дела — каждый включается и выключается своей плашкой
const PlannerLayerChips = ({ layers, onToggle }: OwnProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onToggle(e.currentTarget.dataset.layer as PlannerLayer);
  });

  return (
    <div className={styles.chips} role="group" aria-label={lang('PlannerLayers')}>
      {PLANNER_LAYERS.map((layer) => (
        <button
          key={layer}
          type="button"
          className={buildClassName(styles.chip, LAYER_KINDS[layer], layers[layer] && styles.chipOn)}
          aria-pressed={layers[layer]}
          data-layer={layer}
          onClick={handleClick}
        >
          <span className={styles.chipDot} />
          {lang(LAYER_LABELS[layer])}
        </button>
      ))}
    </div>
  );
};

export default memo(PlannerLayerChips);
