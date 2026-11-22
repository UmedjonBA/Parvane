import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

import ModuleLoading from './ModuleLoading';

// Parvane (B2): раздел «План» — из бандла `Parvane`, вне критического пути старта
const PlannerAsync = () => {
  const Planner = useModuleLoader(Bundles.Parvane, 'Planner', undefined, true);

  return Planner ? <Planner /> : <ModuleLoading id="ParvanePlanner" />;
};

export default PlannerAsync;
