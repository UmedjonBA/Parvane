import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

// Parvane (B2): раздел «План» — из бандла `Parvane`, вне критического пути старта
const PlannerAsync = () => {
  const Planner = useModuleLoader(Bundles.Parvane, 'Planner');

  return Planner ? <Planner /> : undefined;
};

export default PlannerAsync;
