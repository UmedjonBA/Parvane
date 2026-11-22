import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

import ModuleLoading from './ModuleLoading';

// Parvane (spec 041): модуль «Здоровье» — из бандла `Parvane`, вне критического пути старта
const HealthAsync = () => {
  const Health = useModuleLoader(Bundles.Parvane, 'Health', undefined, true);

  return Health ? <Health /> : <ModuleLoading id="ParvaneHealth" />;
};

export default HealthAsync;
