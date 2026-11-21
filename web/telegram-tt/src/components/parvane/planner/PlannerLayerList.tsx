import { memo } from '../../../lib/teact/teact';

import type { PlannerLayer } from './plannerLayers';

import buildClassName from '../../../util/buildClassName';
import {
  getIsLayerLocked, getPlannerLayerPrefs, PLANNER_LAYERS, toggleLayer,
} from './plannerLayers';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import PvSwitch from '../notes/PvSwitch';

import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type OwnProps = {
  // Телефон: события всегда видны — выключатель заблокирован включённым (доска `RpPlan`)
  isNarrow?: boolean;
};

const LAYER_LABELS = {
  events: 'PlannerLayerEvents',
  tasks: 'PlannerLayerTasks',
  sleep: 'PlannerHealthSleep',
  food: 'PlannerHealthFood',
  sport: 'PlannerLayerSport',
} as const satisfies Record<PlannerLayer, string>;
const LAYER_HINTS = {
  events: 'PlannerLayerEventsHint',
  tasks: 'PlannerLayerTasksHint',
  sleep: 'PlannerLayerFromHealth',
  food: 'PlannerLayerFromHealth',
  sport: 'PlannerLayerFromHealth',
} as const satisfies Record<PlannerLayer, string>;
const LAYER_KINDS = {
  events: styles.kindEvent,
  tasks: styles.kindTask,
  sleep: styles.kindSleep,
  food: styles.kindFood,
  sport: styles.kindWorkout,
} satisfies Record<PlannerLayer, string>;

// Слои календаря (доска `RpPlan`): события, задачи, сон, еда, спорт — строка с точкой цвета и выключателем.
// Слой «Здоровья» при выключенном модуле или блоке заблокирован выключенным с подписью «блок выключен»
const PlannerLayerList = ({ isNarrow }: OwnProps) => {
  const lang = useLang();
  const { layers } = useDerivedState(getPlannerLayerPrefs);
  const { enabled, prefs } = useParvaneModules();
  const isHealthOn = enabled.includes('health');

  const handleClick = useLastCallback((isOn: boolean, e: React.MouseEvent<HTMLButtonElement>) => {
    toggleLayer(e.currentTarget.dataset.layer as PlannerLayer);
  });

  return (
    <div className={pv.layers} role="group" aria-label={lang('PlannerLayers')}>
      {PLANNER_LAYERS.map((layer) => {
        const isHealthLocked = getIsLayerLocked(layer, isHealthOn, prefs.healthBlocks);
        const isEventsLocked = layer === 'events' && isNarrow;
        return (
          <PvSwitch
            key={layer}
            isOn={isEventsLocked || (!isHealthLocked && layers[layer])}
            isDisabled={isHealthLocked || isEventsLocked}
            className={buildClassName(pv.layer, LAYER_KINDS[layer])}
            data-layer={layer}
            data-locked={isHealthLocked || isEventsLocked || undefined}
            onChange={handleClick}
          >
            <span className={pv.layerDot} />
            <span className={pv.layerText}>
              <span>{lang(LAYER_LABELS[layer])}</span>
              <span className={pv.layerHint}>
                {lang(isHealthLocked ? 'PlannerLayerBlockOff' : LAYER_HINTS[layer])}
              </span>
            </span>
          </PvSwitch>
        );
      })}
    </div>
  );
};

export default memo(PlannerLayerList);
