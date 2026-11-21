import { useRef } from '../../../lib/teact/teact';

import { Bundles } from '../../../util/moduleLoader';
import { getPlannerAddRequest } from '../../../util/parvaneSection';

import useDerivedState from '../../../hooks/useDerivedState';
import useModuleLoader from '../../../hooks/useModuleLoader';

// Parvane: окно «Новая запись» поверх любого модуля (Ctrl+N) — код из бандла `Parvane`, грузится при первом
// запросе «на месте», а не при запуске
const PlannerQuickHostAsync = () => {
  const request = useDerivedState(getPlannerAddRequest);
  const wasRequestedRef = useRef(false);
  if (request?.isInPlace) wasRequestedRef.current = true;
  const PlannerQuickHost = useModuleLoader(Bundles.Parvane, 'PlannerQuickHost', !wasRequestedRef.current);

  return PlannerQuickHost ? <PlannerQuickHost /> : undefined;
};

export default PlannerQuickHostAsync;
