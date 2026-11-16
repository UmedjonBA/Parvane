import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

// Parvane (spec 041): модуль «Здоровье» — из бандла `Parvane`, вне критического пути старта
const HealthAsync = () => {
  const Health = useModuleLoader(Bundles.Parvane, 'Health');

  return Health ? <Health /> : undefined;
};

export default HealthAsync;
