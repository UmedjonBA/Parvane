import { memo } from '../../../lib/teact/teact';

import type { PlannerLayer, PlannerLayers } from './plannerLayers';

import buildClassName from '../../../util/buildClassName';
import { PLANNER_LAYERS } from './plannerLayers';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSwitch from '../notes/PvSwitch';

import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type OwnProps = {
  layers: PlannerLayers;
  onToggle: (layer: PlannerLayer) => void;
};

const LAYER_LABELS = {
  sleep: 'PlannerHealthSleep',
  food: 'PlannerHealthFood',
  work: 'PlannerLayerWork',
} as const satisfies Record<PlannerLayer, string>;
const LAYER_HINTS = {
  sleep: 'PlannerLayerFromHealth',
  food: 'PlannerLayerFromHealth',
  work: 'PlannerLayerWorkHint',
} as const satisfies Record<PlannerLayer, string>;
const LAYER_KINDS = {
  sleep: styles.kindSleep,
  food: styles.kindFood,
  work: styles.kindEvent,
} satisfies Record<PlannerLayer, string>;

// Слои календаря (доска `RpPlan`): сон, еда, дела — строка с точкой цвета и выключателем
const PlannerLayerList = ({ layers, onToggle }: OwnProps) => {
  const lang = useLang();

  const handleClick = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    onToggle(e.currentTarget.dataset.layer as PlannerLayer);
  });

  return (
    <div className={pv.layers} role="group" aria-label={lang('PlannerLayers')}>
      {PLANNER_LAYERS.map((layer) => (
        <PvSwitch
          key={layer}
          isOn={layers[layer]}
          className={buildClassName(pv.layer, LAYER_KINDS[layer])}
          data-layer={layer}
          onChange={handleClick}
        >
          <span className={pv.layerDot} />
          <span className={pv.layerText}>
            <span>{lang(LAYER_LABELS[layer])}</span>
            <span className={pv.layerHint}>{lang(LAYER_HINTS[layer])}</span>
          </span>
        </PvSwitch>
      ))}
    </div>
  );
};

export default memo(PlannerLayerList);
